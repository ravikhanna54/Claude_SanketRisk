"""Nightly backup of SanketRisk COMMERCIAL (Supabase): database only -> one .tar.gz.
Stored files (photos, PDFs) are copied separately by 'gdrive.py mirror' because they are large.
Env: SUPABASE_DB_URL (session pooler string), SUPABASE_URL, SUPABASE_SERVICE_KEY.
Usage: python backup/backup.py <output.tar.gz>
"""
import os, sys, json, subprocess, tarfile, datetime, pathlib
import requests

out = pathlib.Path(sys.argv[1])
work = pathlib.Path("work"); work.mkdir(exist_ok=True)
db = os.environ["SUPABASE_DB_URL"]
base = os.environ["SUPABASE_URL"].rstrip("/")
key = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": key}
if key.startswith("eyJ"):
    H["Authorization"] = "Bearer " + key
manifest = {"created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "problems": []}

def run(cmd):
    subprocess.run(cmd, check=True)

# 1) database: public schema (tables, data, functions, policies).
#    Building-footprint tables keep their structure but not their millions of rows
#    (that data is public Microsoft data and can be re-imported with import-footprints.js).
run(["pg_dump", db, "--schema=public", "--no-owner", "--no-privileges",
     "--exclude-table-data=public.building_footprints_*", "-f", str(work / "database-public.sql")])
# user accounts (only needed if Auth ever has to be rebuilt)
run(["pg_dump", db, "--data-only", "--column-inserts", "--table=auth.users", "--table=auth.identities", "-f", str(work / "auth-users.sql")])
size = (work / "database-public.sql").stat().st_size
manifest["database_sql_bytes"] = size
if size < 5000:
    raise SystemExit("database dump is suspiciously small (%d bytes) - failing so you get an email" % size)

# 2) inventory of stored files (names + sizes) so a restore can be checked against it
def list_objects(bucket, prefix=""):
    found, offset = [], 0
    while True:
        r = requests.post(f"{base}/storage/v1/object/list/{bucket}", headers=H, timeout=60,
                          json={"prefix": prefix, "limit": 100, "offset": offset, "sortBy": {"column": "name", "order": "asc"}})
        r.raise_for_status()
        items = r.json()
        for it in items:
            path = (prefix + "/" if prefix else "") + it["name"]
            if it.get("id") is None:
                found += list_objects(bucket, path)
            else:
                found.append({"path": path, "size": (it.get("metadata") or {}).get("size")})
        if len(items) < 100:
            return found
        offset += 100

r = requests.get(f"{base}/storage/v1/bucket", headers=H, timeout=60); r.raise_for_status()
inventory = {}
for b in r.json():
    inventory[b["name"]] = list_objects(b["name"])
manifest["buckets"] = {k: len(v) for k, v in inventory.items()}
(work / "storage-inventory.json").write_text(json.dumps(inventory))
(work / "manifest.json").write_text(json.dumps(manifest, indent=2))
with tarfile.open(out, "w:gz") as t:
    t.add(work, arcname="sanket-commercial-backup")
print(json.dumps(manifest, indent=2))
