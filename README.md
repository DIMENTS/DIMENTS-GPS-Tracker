\
# DIMENTS GPS Tracker — Jetson Nano (24/7) setup (DuckDNS + Let's Encrypt + NDJSON)

Doel:
- Jetson Nano 8GB draait jouw tracker 24/7
- **Endpoints & bestandsnamen blijven identiek**
- Route logging wordt **NDJSON (append-only)** zodat RAM niet volloopt
- DuckDNS + Let's Encrypt certificaten worden **volautomatisch** bijgewerkt
- Updates gaan via `git pull` + restart

## Wat blijft hetzelfde
- Alle API endpoints blijven gelijk (routes, routesets, POI’s, privacy zones, etc.)
- Bestandsnamen in `data/` blijven gelijk (`routeData.json`, `routesets.json`, `routeset_<id>.json`, ...)
- Credentials blijven in `.env` (zelfde tokens/keys)

---

## 1) Jetson op netwerk + IPv4 adres vinden

### Op Jetson (met monitor/keyboard)
```bash
hostname -I
# of
ip -4 addr show
```

### Via je router
DHCP leases / connected devices → zoek “Jetson/NVIDIA” → pak het LAN IP (bv. 192.168.1.50).

> TIP: Zet DHCP reservation aan zodat dit IP altijd hetzelfde blijft.

---

## 2) Remote toegang (SSH)

Op Jetson:
```bash
bash scripts/install_prereqs.sh
```

Vanaf Windows PowerShell:
```powershell
ssh <user>@<jetson-ip>
```

---

## 3) Node installeren (auto-detect Ubuntu versie)

```bash
bash scripts/install_node.sh
node -v
npm -v
```

---

## 4) Project installeren (git clone)

Aanrader:
```bash
sudo mkdir -p /opt
sudo chown $USER:$USER /opt
cd /opt
git clone <jouw-repo-url> diments-gps-tracker
cd diments-gps-tracker
```

---

## 5) `.env` maken

Kopieer template:
```bash
cp .env.example .env
nano .env
```

Minimaal invullen:
- `DOMAIN=irllogging.duckdns.org`
- `PORT=3000`
- `MAPBOX_TOKEN=...`
- `OPENWEATHER_KEY=...`
- `ROUTE_STORAGE=ndjson`
- `LE_EMAIL=...` (voor Let's Encrypt)
- `DUCKDNS_TOKEN=...`
- `DUCKDNS_SUBDOMAIN=irllogging`

Certs path (aanrader):
- `CERT_PATH=/etc/letsencrypt/live/irllogging.duckdns.org`

SSD later? Laat `DATA_DIR` leeg. Later kun je `DATA_DIR=/mnt/ssd/diments-gps-tracker/data` zetten.

---

## 6) Data migreren (optioneel, maar meestal gewenst)

Kopieer je huidige `data/` folder van je PC naar Jetson:
```powershell
scp -r "C:\pad\naar\project\data" <user>@<jetson-ip>:/opt/diments-gps-tracker/
```

Check:
```bash
ls -la data
```

---

## 7) RouteData migreren naar NDJSON (1x)

Als `data/routeData.json` nog een JSON array is (begint met `[`):
```bash
node scripts/migrate-route-to-ndjson.js data/routeData.json
```

Er wordt automatisch een backup gemaakt: `routeData.json.bak-...`.

---

## 8) Certbot + DuckDNS DNS-01 (volautomatisch)

### 8.1 Certbot installeren
```bash
bash scripts/install_certbot.sh
```

### 8.2 Eerste certificaat ophalen
```bash
bash scripts/setup_ssl_duckdns.sh
```

Certbot gebruikt DNS-01 en zet automatisch de TXT-record via DuckDNS API. 
DuckDNS ondersteunt TXT/clear updates via hun update endpoint.
Certbot manual certs kunnen automatisch vernieuwen als je auth/cleanup hooks gebruikt.

---

## 9) Dependencies installeren

```bash
npm ci --omit=dev || npm install --omit=dev
```

---

## 10) Systemd (24/7 + autorestart + auto renew timers)

Installeer services/timers:
```bash
bash scripts/install_systemd.sh
```

Start + enable tracker:
```bash
sudo systemctl enable --now diments-gps-tracker.service
```

DuckDNS IP updater (elke 5 min):
```bash
sudo systemctl enable --now duckdns.timer
```

Cert renew (2x per dag):
```bash
sudo systemctl enable --now diments-certbot-renew.timer
```

Logs:
```bash
journalctl -u diments-gps-tracker -f
```

Timer status:
```bash
systemctl list-timers --all | grep -E "duckdns|diments-certbot"
```

---

## 11) Router: port-forward

Je domein `irllogging.duckdns.org:3000` werkt extern alleen als je router forward naar de Jetson:
- extern `3000` → intern `<JETSON_LAN_IP>:3000`

DuckDNS zelf wijst naar je **WAN/public IP**. De forwarding bepaalt naar welke machine (PC → Jetson) het gaat.

---

## 12) Updates via git pull

Op Jetson:
```bash
bash scripts/update.sh
```

Vanaf je PC:
```powershell
ssh <user>@<jetson-ip> "cd /opt/diments-gps-tracker && bash scripts/update.sh"
```

---

## 13) SSD later toevoegen (optioneel)

1) Mount SSD op `/mnt/ssd` (jij kiest plek)
2) Maak data dir:
```bash
sudo mkdir -p /mnt/ssd/diments-gps-tracker/data
sudo chown -R $USER:$USER /mnt/ssd/diments-gps-tracker
```

3) Kopieer data:
```bash
cp -r data/* /mnt/ssd/diments-gps-tracker/data/
```

4) Zet in `.env`:
```env
DATA_DIR=/mnt/ssd/diments-gps-tracker/data
```

5) Restart:
```bash
sudo systemctl restart diments-gps-tracker
```

---

## 14) Quick checks

- Health:
  - `https://irllogging.duckdns.org:3000/api/health`
- Route:
  - `/api/route`
- Routesets:
  - `/api/routesets`
- Public geojson:
  - `/api/route/public-file`
