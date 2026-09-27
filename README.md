# LiveAssist hub

The server behind the LiveAssist AI Chat WordPress plugin. It holds live conversations, answers visitors with Claude using your site's content, hands chats to your team, and notifies their phones.

It runs as five Docker containers on one small server:

| Container | Job |
|---|---|
| `caddy` | HTTPS with free auto-renewing certificates; routes traffic to the hub |
| `hub` | The app: chat sockets, Claude, WordPress API, team console |
| `db` | PostgreSQL: sites, conversations, leads, knowledge |
| `redis` | Real-time messaging between connections, rate limits, presence |
| `backup` | Nightly database backup to `./backups` |

The contract with the WordPress plugin is in [HUB-PROTOCOL.md](HUB-PROTOCOL.md).

---

## Deploy on AWS Lightsail

These steps assume an Ubuntu Lightsail instance with a static IP attached, ports 80 and 443 open in its firewall, and a DNS A record for `chat.presspros.io` pointing at that IP.

### 1. Put this code on GitHub

Create a **private** repository (for example `liveassist-hub`) and upload this folder's contents to it. You can drag the files into the GitHub web page, use GitHub Desktop, or run:

```
git init && git add . && git commit -m "LiveAssist hub"
git branch -M main
git remote add origin https://github.com/<you>/liveassist-hub.git
git push -u origin main
```

`.gitignore` keeps secrets (`.env`, `secrets/`, `backups/`) out of the repository.

### 2. Copy it to the server

In Lightsail, open the instance and click **Connect using SSH**, then:

```
git clone https://github.com/<you>/liveassist-hub.git
cd liveassist-hub
```

GitHub asks for a username and password. For the password, use a **personal access token**, not your GitHub password. Create one at GitHub → Settings → Developer settings → Fine-grained tokens, with read-only **Contents** access to this one repository.

### 3. Prepare the server (one time)

```
bash scripts/setup-server.sh
```

This updates Ubuntu, installs Docker, adds swap memory, turns on automatic security updates, and creates `.env` with strong generated passwords. If it says Docker was just installed, close the SSH window, open a new one, and run `cd liveassist-hub`.

### 4. Add your settings

```
nano .env
```

Set these three lines:

```
HUB_DOMAIN=chat.presspros.io
ACME_EMAIL=you@presspros.io
ANTHROPIC_API_KEY=sk-ant-...
```

Save with Ctrl + O and Enter, then exit with Ctrl + X. Don't touch the generated values. Changing `HUB_ENCRYPTION_KEY` later makes existing site secrets unreadable.

> Want to try everything before adding a Claude key? Set `AI_MOCK=1`. The assistant gives canned test replies, and every other feature works. Set it back to `0` when you add the key.

### 5. Start it

```
docker compose up -d --build
```

The first build takes a few minutes.

### 6. Check it's running

```
docker compose ps
```

Every row should say `Up (healthy)` (`backup` has no health check and just says `Up`). Then open **https://chat.presspros.io/health** in your browser. A padlock and `{"ok":true}` means DNS, the firewall, the certificate and the hub all work.

### 7. Connect WordPress

```
docker compose exec hub npm run site:create -- --name "PressPros" --url https://presspros.io
```

Copy the Hub URL, Site ID and Site secret it prints. The secret is shown only once. In WordPress, go to **LiveAssist → Settings → Connection**, paste them, save, then click **Test connection** and **Sync now**.

`--url` must be the exact address visitors use (https, no trailing path). The hub only accepts chat connections from that site, plus its www/non-www twin.

### 8. Create your team login

```
docker compose exec hub npm run agent:create -- --email you@presspros.io --name "Stacy" --admin
```

It prints a **temporary password**. Sign in at **https://chat.presspros.io/console/** or in the LiveAssist phone app, and you'll be asked to choose your own password. In the console, click **Turn on alerts** to get a browser notification when a visitor asks for a person.

Anyone can change their password later: use **Change password** in the console's top bar, or **Settings → Change password** in the app. It signs out their other devices.

---

## Everyday commands

Run these from the `liveassist-hub` folder on the server.

| Task | Command |
|---|---|
| See status | `docker compose ps` |
| Watch hub logs | `docker compose logs -f hub` (Ctrl + C to stop) |
| Certificate logs | `docker compose logs caddy` |
| Update to the latest code | `git pull && docker compose up -d --build` |
| Restart everything | `docker compose restart` |
| Stop everything | `docker compose down` (your data is kept) |
| List all commands | `docker compose exec hub npm run cli -- help` |
| List sites | `docker compose exec hub npm run site:list` |
| New secret for a site | `docker compose exec hub npm run site:rotate-secret -- --id presspros` |
| Pause chat on a site | `docker compose exec hub npm run site:disable -- --id presspros` |
| Add a team member | `docker compose exec hub npm run agent:create -- --email sam@presspros.io --name "Sam"` |
| Reset a forgotten password (issues a temporary one) | `docker compose exec hub npm run agent:reset-password -- --email sam@presspros.io` |
| Remove a team member | `docker compose exec hub npm run agent:remove -- --email sam@presspros.io` |

Each extra WordPress site gets its own `site:create`, and all sites share this one hub.

## Backups

The `backup` container writes a compressed database dump to `./backups` every day and keeps 14 days (change with `BACKUP_KEEP_DAYS`). Also turn on **automatic snapshots** for the instance in Lightsail, which back up the whole server.

To restore a dump:

```
docker compose stop hub
gunzip -c backups/liveassist-YYYYMMDD-HHMMSS.sql.gz | docker compose exec -T db psql -U liveassist -d liveassist
docker compose start hub
```

For a clean restore, first recreate the database: `docker compose exec db dropdb -U liveassist liveassist && docker compose exec db createdb -U liveassist liveassist`.

## Troubleshooting

| What you see | Likely cause and fix |
|---|---|
| `caddy` logs show "challenge failed" or "timeout" | DNS doesn't point at this server yet, or port 80/443 is closed in the Lightsail firewall. Fix it, then `docker compose restart caddy`. |
| `hub` keeps restarting | Run `docker compose logs hub --tail 30`. It names the missing or invalid `.env` value. |
| Test connection: "Unknown site ID" | The Site ID in WordPress doesn't match `site:list`. |
| Test connection: "Signature check failed" | Re-paste the Site secret, or run `site:rotate-secret` and paste the new one. If it still fails, the WordPress server's clock may be wrong. |
| Chat shows "Leave a message" instead of chatting | The hub is unreachable from the browser, or `--url` doesn't match the site's address. `docker compose logs hub \| grep origin` shows rejected origins. |
| Leads don't reach WordPress | A security plugin or firewall is blocking `/wp-json/laic/v1/webhook`. Allow the server's static IP. Failed deliveries retry for 24 hours. |
| Log says the API key "is not scoped to a workspace" | Create the key inside a workspace in the Anthropic Console, or set `ANTHROPIC_WORKSPACE_ID` in `.env`, then `docker compose up -d`. |
| The assistant says it's "having trouble" | Check `docker compose logs hub` for Claude API errors: a missing or invalid key, or the spend limit was reached. |

## Costs and limits

Set these in `.env`, then run `docker compose up -d` to apply:

- `AI_MAX_TURNS_PER_CONVERSATION` (default 40): the assistant stops answering and offers follow-up.
- `AI_MAX_TURNS_PER_SITE_DAILY` (default 2000): a hard daily cap per site.
- `VISITOR_MESSAGES_PER_MINUTE` (default 12): per-visitor rate limit.
- `MODEL_ECONOMY` / `MODEL_BALANCED` / `MODEL_BEST`: which Claude model each "Answer quality" setting in WordPress uses.

The system prompt is marked for prompt caching, so repeated questions on the same site cost less. Also set a monthly spend limit in the Anthropic Console.

## Push notifications (for the mobile app)

The LiveAssist app registers each phone with the hub. The hub sends notifications through **Expo's push service**, which delivers them through Apple and Google. **Nothing needs configuring on this server.** The Apple and Firebase setup lives in the app project (see its README).

The hub sends a notification to every signed-in phone when a visitor asks for a person, and to the assigned team member when a visitor replies while they're away from the app. Phones that uninstall the app are removed automatically.

Optional settings:
- `EXPO_ACCESS_TOKEN` in `.env`: only if you turn on "enhanced push security" for the project on expo.dev.
- `FIREBASE_SERVICE_ACCOUNT`: only for apps that register raw Firebase tokens instead of Expo tokens. The LiveAssist app doesn't need it.

## Security notes

- Visitors never see your Claude key. Only the hub calls Claude.
- WordPress and the hub sign every request with the site secret (HMAC-SHA256, 5-minute window). Site secrets are encrypted in the database with `HUB_ENCRYPTION_KEY`.
- Visitor tokens expire after 2 hours and only work from the site's own address.
- Team passwords are hashed with scrypt. Sign-in and password changes are rate-limited. New and reset accounts get a temporary password that must be replaced at first sign-in, and every password change signs that person out of their other devices.
- Postgres and Redis are only reachable inside Docker, never from the internet.

## Local development

```
npm install
cp .env.example .env    # set DATABASE_URL and REDIS_URL to local services, AI_MOCK=1
npm run dev
```
