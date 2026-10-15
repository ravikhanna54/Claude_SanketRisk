"""Google Drive helper for the COMMERCIAL backup.
  python backup/gdrive.py authorize          (one time: sign in with a code)
  python backup/gdrive.py upload <file>      (nightly: upload database backup + delete copies older than KEEP_DAYS)
  python backup/gdrive.py mirror             (nightly: copy NEW stored files from Supabase Storage; never deletes anything)
Env: GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, BACKUP_PASSPHRASE; for mirror also SUPABASE_URL, SUPABASE_SERVICE_KEY.
Uses the 'drive.file' permission: the job can only see files it created itself.
"""
import os, sys, json, time, subprocess, datetime, pathlib, re, tempfile
import requests

CID = os.environ["GDRIVE_CLIENT_ID"]
SECRET = os.environ["GDRIVE_CLIENT_SECRET"]
PASS = os.environ["BACKUP_PASSPHRASE"]
SCOPE = "https://www.googleapis.com/auth/drive.file"
FOLDER = os.environ.get("GDRIVE_FOLDER", "SanketCommercial-Backups")
FILES_FOLDER = "stored-files"
PREFIX = "sanket-commercial"
KEEP_DAYS = int(os.environ.get("KEEP_DAYS", "30"))
MIRROR_MINUTES = int(os.environ.get("MIRROR_MINUTES", "300"))
API = "https://www.googleapis.com/drive/v3"
state = pathlib.Path("state"); state.mkdir(exist_ok=True)
enc, plain = state / "gdrive.gpg", state / "gdrive.json"

def gpg(args):
    subprocess.run(["gpg", "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase", PASS] + args, check=True)

def save_token(refresh):
    plain.write_text(json.dumps({"refresh_token": refresh}))
    gpg(["-c", "--cipher-algo", "AES256", "-o", str(enc), str(plain)])
    plain.unlink()

def authorize():
    r = requests.post("https://oauth2.googleapis.com/device/code", data={"client_id": CID, "scope": SCOPE}); r.raise_for_status()
    d = r.json()
    print("\n=================================================")
    print("ON YOUR TABLET open:  " + d.get("verification_url", "https://www.google.com/device"))
    print("and enter this code:  " + d["user_code"])
    print("Sign in as the Google account that should hold the backups.")
    print("(you have about 15 minutes)")
    print("=================================================\n", flush=True)
    end = time.time() + d["expires_in"]; interval = d.get("interval", 5)
    while time.time() < end:
        time.sleep(interval)
        t = requests.post("https://oauth2.googleapis.com/token", data={"client_id": CID, "client_secret": SECRET, "device_code": d["device_code"],
                          "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
        j = t.json()
        if "refresh_token" in j:
            save_token(j["refresh_token"]); print("Signed in. Token saved (encrypted)."); return
        if j.get("error") == "slow_down": interval += 5
        elif j.get("error") != "authorization_pending":
            raise SystemExit("Sign-in failed: " + json.dumps(j))
    raise SystemExit("Timed out waiting for sign-in. Run the workflow again.")

class Auth:
    """Access tokens last 1 hour; refresh every 40 minutes so long copy runs keep working."""
    def __init__(self):
        gpg(["-d", "-o", str(plain), str(enc)])
        self.refresh = json.loads(plain.read_text())["refresh_token"]; plain.unlink()
        self.token, self.at = None, 0
    def headers(self):
        if not self.token or time.time() - self.at > 2400:
            t = requests.post("https://oauth2.googleapis.com/token", data={"client_id": CID, "client_secret": SECRET, "refresh_token": self.refresh, "grant_type": "refresh_token"})
            j = t.json()
            if "access_token" not in j:
                raise SystemExit("Google sign-in expired or was revoked - run the 'Google Drive sign-in' workflow again. " + json.dumps(j))
            self.token, self.at = j["access_token"], time.time()
        return {"Authorization": "Bearer " + self.token}

def find_or_make_folder(auth, name, parent=None):
    q = f"name = '{name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
    if parent: q += f" and '{parent}' in parents"
    r = requests.get(API + "/files", headers=auth.headers(), params={"q": q, "fields": "files(id,name)", "spaces": "drive"}); r.raise_for_status()
    files = r.json().get("files", [])
    if files: return files[0]["id"]
    body = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
    if parent: body["parents"] = [parent]
    r = requests.post(API + "/files", headers=auth.headers(), json=body); r.raise_for_status()
    return r.json()["id"]

def list_children(auth, fid):
    out, page = [], None
    while True:
        params = {"q": f"'{fid}' in parents and trashed = false", "fields": "nextPageToken,files(id,name,size)", "pageSize": 1000}
        if page: params["pageToken"] = page
        r = requests.get(API + "/files", headers=auth.headers(), params=params); r.raise_for_status(); j = r.json()
        out += j.get("files", []); page = j.get("nextPageToken")
        if not page: return out

def upload_file(auth, fid, name, path):
    p = pathlib.Path(path); size = p.stat().st_size
    s = requests.post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
                      headers={**auth.headers(), "X-Upload-Content-Type": "application/octet-stream", "X-Upload-Content-Length": str(size)},
                      json={"name": name, "parents": [fid]}); s.raise_for_status()
    url = s.headers["Location"]; chunk = 256 * 1024 * 16
    with open(p, "rb") as f:
        pos = 0
        while pos < size or size == 0:
            data = f.read(chunk)
            rng = f"bytes {pos}-{pos+len(data)-1}/{size}" if size else "bytes */0"
            r = requests.put(url, data=data, headers={"Content-Length": str(len(data)), "Content-Range": rng})
            if r.status_code not in (200, 201, 308): raise RuntimeError("Upload failed: %s %s" % (r.status_code, r.text[:300]))
            pos += len(data)
            if size == 0: break

def upload(path):
    auth = Auth(); fid = find_or_make_folder(auth, FOLDER)
    p = pathlib.Path(path)
    upload_file(auth, fid, p.name, p)
    print("Uploaded", p.name, p.stat().st_size, "bytes")
    cutoff = datetime.date.today() - datetime.timedelta(days=KEEP_DAYS)
    for it in list_children(auth, fid):
        m = re.match(PREFIX + r"-(\d{4}-\d{2}-\d{2})", it["name"])
        if m and datetime.date.fromisoformat(m.group(1)) < cutoff:
            requests.delete(API + "/files/" + it["id"], headers=auth.headers()); print("Deleted old copy", it["name"])

def storage_objects(base, H):
    r = requests.get(f"{base}/storage/v1/bucket", headers=H, timeout=60); r.raise_for_status()
    def walk(bucket, prefix=""):
        offset = 0
        while True:
            q = requests.post(f"{base}/storage/v1/object/list/{bucket}", headers=H, timeout=60,
                              json={"prefix": prefix, "limit": 100, "offset": offset, "sortBy": {"column": "name", "order": "asc"}})
            q.raise_for_status(); items = q.json()
            for it in items:
                path = (prefix + "/" if prefix else "") + it["name"]
                if it.get("id") is None:
                    for x in walk(bucket, path): yield x
                else:
                    yield bucket, path, (it.get("metadata") or {}).get("size")
            if len(items) < 100: return
            offset += 100
    for b in r.json():
        for x in walk(b["name"]): yield x

def mirror():
    """Copy stored files that are not yet in Drive. Existing copies are never changed or deleted."""
    base = os.environ["SUPABASE_URL"].rstrip("/"); key = os.environ["SUPABASE_SERVICE_KEY"]
    H = {"apikey": key}
    if key.startswith("eyJ"): H["Authorization"] = "Bearer " + key
    auth = Auth(); top = find_or_make_folder(auth, FOLDER); fid = find_or_make_folder(auth, FILES_FOLDER, top)
    have = {it["name"]: it for it in list_children(auth, fid)}
    print("Already in Drive:", len(have), "files")
    deadline = time.time() + MIRROR_MINUTES * 60
    copied = skipped = failed = 0; copied_bytes = 0; stopped_early = False
    for bucket, path, size in storage_objects(base, H):
        name = bucket + "~" + path.replace("/", "~")          # '~' stands in for folder slashes
        if name in have:
            skipped += 1; continue
        if time.time() > deadline:
            stopped_early = True; break
        try:
            with tempfile.NamedTemporaryFile(delete=False) as tmp:
                with requests.get(f"{base}/storage/v1/object/{bucket}/{path}", headers=H, stream=True, timeout=120) as d:
                    d.raise_for_status()
                    for blk in d.iter_content(1024 * 1024): tmp.write(blk)
            upload_file(auth, fid, name, tmp.name); copied += 1; copied_bytes += os.path.getsize(tmp.name)
        except Exception as e:
            failed += 1; print("FAILED", name, e)
        finally:
            try: os.unlink(tmp.name)
            except Exception: pass
    print(json.dumps({"copied": copied, "copied_bytes": copied_bytes, "already_there": skipped, "failed": failed, "stopped_early": stopped_early}))
    if stopped_early: print("Time budget reached - the rest will be copied on the next nightly run.")
    if failed: raise SystemExit("%d stored files could not be copied - see log above" % failed)

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "authorize": authorize()
    else:
        if not enc.exists(): raise SystemExit("No Google sign-in yet - run the 'Google Drive sign-in' workflow first.")
        if cmd == "upload": upload(sys.argv[2])
        elif cmd == "mirror": mirror()
        else: raise SystemExit("unknown command " + cmd)
