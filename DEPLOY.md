# Deploying chilocal on Unraid

This app builds from a `Dockerfile`. Unraid's **built-in Docker tab can only run
pre-built images**, so we let GitHub build the image and Unraid pull it.

## Path A — GitHub Actions → GHCR → Unraid Docker tab (no plugins)

1. **Push this folder to a GitHub repo** named `chilocal` (a git repo is already
   initialized here):
   ```bash
   git remote add origin https://github.com/<you>/chilocal.git
   git push -u origin main
   ```
2. The included workflow (`.github/workflows/docker-publish.yml`) runs
   automatically and publishes an image to
   `ghcr.io/<you>/chilocal:latest`.
3. **Make the package public** (one-time): GitHub → your profile → Packages →
   `chilocal` → Package settings → Change visibility → Public. (Otherwise Unraid
   needs a registry login.)
4. **Unraid → Docker → Add Container:**
   - Repository: `ghcr.io/<you>/chilocal:latest`
   - Network: `bridge`
   - Add a Port: container `80` → host `8080`
   - Apply. Browse to `http://<server-ip>:8080`.
5. **Updates:** push to GitHub → re-run finishes → on Unraid click *Force update*
   on the container (or Check for Updates).

## Path B — Compose Manager plugin (builds on the server from git)

If you install **Docker Compose Manager** (Community Apps): add a new stack,
point it at the GitHub repo URL, Compose Up. It builds locally — no GHCR step,
and the build-time `fetch-data.sh` pulls full-resolution boundaries.

## Path C — One-off via Unraid terminal

```bash
cd /mnt/user/appdata
git clone https://github.com/<you>/chilocal.git
cd chilocal
docker build -t chilocal .
docker run -d --name chilocal --restart unless-stopped -p 8080:80 chilocal
```
