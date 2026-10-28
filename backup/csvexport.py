"""Nightly CSV export: every table in the public schema -> one CSV each -> csv-export.zip
(readable in Excel once decrypted). Building-footprint tables are skipped (huge, public data).
Env: SUPABASE_DB_URL. Usage: python backup/csvexport.py <output.zip>"""
import os, sys, subprocess, zipfile, pathlib, shutil

out = pathlib.Path(sys.argv[1])
db = os.environ["SUPABASE_DB_URL"]
d = pathlib.Path("csv_work"); shutil.rmtree(d, ignore_errors=True); d.mkdir()

q = "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name not like 'building_footprints%' order by 1"
tables = subprocess.run(["psql", db, "-At", "-c", q], check=True, capture_output=True, text=True).stdout.split()
if not tables:
    raise SystemExit("no tables found - failing so you get an email")
problems = []
for t in tables:
    f = d / (t + ".csv")
    r = subprocess.run(["psql", db, "-c", "\\copy (select * from public.\"%s\") to '%s' csv header" % (t, f)], capture_output=True, text=True)
    if r.returncode != 0:
        problems.append(t); print("FAILED", t, r.stderr[:200])
    else:
        print("ok", t)
if len(problems) > max(2, len(tables) // 4):
    raise SystemExit("too many tables failed: " + ", ".join(problems))
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for p in sorted(d.glob("*.csv")):
        z.write(p, p.name)
    z.writestr("README.txt", "CSV export of every table. Tables that failed: %s\n" % (", ".join(problems) or "none"))
shutil.rmtree(d, ignore_errors=True)
print("wrote", out, out.stat().st_size, "bytes;", len(tables) - len(problems), "tables")
