<div align="center">

<img src="./logo_m.png" alt="OPNsense VoucherBox">

# OPNsense VoucherBox

**A simple, standalone web interface for generating OPNsense Captive Portal vouchers.**

Generate guest Wi-Fi vouchers without giving users access to the OPNsense WebGUI.

</div>

---

## 📖 About

**OPNsense VoucherBox** provides a dedicated web interface for creating and distributing **OPNsense Captive Portal vouchers**.

Instead of giving reception staff, helpdesk users, or other operators access to the OPNsense administration interface, VoucherBox provides a focused interface for the voucher-generation workflow while using OPNsense as the underlying voucher authority.

Typical use cases include:

* Guest Wi-Fi at hotels and apartments
* Offices and coworking spaces
* Events and conferences
* Restaurants and cafés
* Temporary network access for visitors

VoucherBox communicates with OPNsense through its API and can optionally deliver generated vouchers by email.
> **Important:** VoucherBox is an administrative application. It should **not be exposed directly to the public Internet without additional authentication and access controls.**

---

## ✨ Features

* 🎟️ Generate OPNsense Captive Portal vouchers
* 📧 Send vouchers by email
* 📱 Generate QR codes for convenient guest access
* 🔌 Uses the OPNsense API
* 🐳 Docker / Docker Compose deployment
* ⚛️ React-based web interface
* 🟦 TypeScript backend
* 📮 Configurable SMTP server
* 🔐 Support for protecting the application behind an external authentication layer
* 🌐 Configurable URL base path
* 🔧 Uses OPNsense's existing Captive Portal and voucher configuration

OPNsense provides voucher authentication as part of its Captive Portal functionality.

---

# 🏗️ Architecture

```text
                         ┌─────────────────────┐
                         │       User          │
                         │                     │
                         │ Browser / Phone     │
                         └──────────┬──────────┘
                                    │
                                    │ HTTPS
                                    ▼
                         ┌─────────────────────┐
                         │   Reverse Proxy     │
                         │                     │
                         │ Caddy / Nginx /     │
                         │ HAProxy / Traefik   │
                         │                     │
                         │ + Authentication    │
                         └──────────┬──────────┘
                                    │
                                    │ authenticated
                                    ▼
                         ┌─────────────────────┐
                         │  OPNsense           │
                         │  VoucherBox         │
                         │                     │
                         │ React + Node.js     │
                         └──────┬─────────┬────┘
                                │         │
                         OPNsense API     │ SMTP
                                │         │
                                ▼         ▼
                       ┌─────────────┐ ┌─────────────┐
                       │  OPNsense   │ │ Mail Server │
                       │  Captive    │ │             │
                       │  Portal     │ └─────────────┘
                       │  Vouchers   │
                       └─────────────┘
```

VoucherBox should normally be placed behind a reverse proxy. The reverse proxy becomes the public entry point and can provide TLS termination, access restrictions, rate limiting, and authentication before traffic reaches VoucherBox.

---

# 🔐 Security: Protect VoucherBox

> ## ⚠️ Do not expose VoucherBox directly to the Internet

VoucherBox should be placed behind an authentication-aware reverse proxy such as:

* Caddy
* Nginx
* HAProxy
* Traefik

Using Auth servers such as:

* **[Authentik](https://goauthentik.io/)**
* **[Authelia](https://www.authelia.com/)**
* **[Keycloak](https://www.keycloak.org/)** 

For example, a reverse proxy can authenticate a user against Authentik, Authelia, or Keycloak before forwarding the request to VoucherBox.

---

# 🔑 Creating an OPNsense User for VoucherBox

VoucherBox requires an OPNsense API account.

**Do not use `root` or your normal OPNsense administrator account.**

Create a dedicated account specifically for VoucherBox.

Official OPNsense documentation:

* [OPNsense — Local Users & Groups](https://docs.opnsense.org/manual/how-tos/user-local.html)
* [OPNsense — Using the API](https://docs.opnsense.org/development/how-tos/api.html)
* [OPNsense — API Reference](https://docs.opnsense.org/development/api.html)

OPNsense's user manager allows privileges to be assigned directly to users or through groups. API keys belong to users, and the effective privileges of that user determine which API resources the key can access.


## Step 1- Create the VoucherBox user

Go to:

**System → Access → Users**

Click **+** to create a new user.

For example:

```text
Username:
voucherbox

Full name:
OPNsense VoucherBox

Description:
API account used by OPNsense VoucherBox

Group membership:
voucherbox
```

Use a strong password even if the account is intended primarily for API access.

OPNsense's user-management documentation recommends using groups for managing privileges rather than assigning privileges individually whenever practical.

---

## Step 2 — Create an API key

Open the newly created `voucherbox` user.

Find the **API Keys** section and create a new API key.

OPNsense generates a key/secret pair.

The credentials will look conceptually like:

```text
key=...
secret=...
```

---

## Step 3 — Configure VoucherBox

Configure the credentials using the VoucherBox environment variables:

```dotenv
API_USERNAME=...
API_PASSWORD=...
OPNSENSE_HOST=...
OPNSENSE_PORT=...
```

The names are retained for compatibility with the application's configuration, but conceptually:

```text
API_USERNAME = OPNsense API key
API_PASSWORD = OPNsense API secret
OPNSENSE_HOST = OPNsense hostname or IP
OPNSENSE_PORT = OPNsense WebGUI/API port (optional, default 443)
```

---

# 🚀 Quick Start

Clone the repository:

```bash
git clone https://github.com/knom/Opnsense-Voucher-WebUI.git
cd Opnsense-Voucher-WebUI
```

Create the environment file:

```bash
cp .env.example .env
```

Edit the configuration:

```bash
nano .env
```

Start VoucherBox:

```bash
docker compose up -d --build
```

Check the logs:

```bash
docker compose logs -f
```

The default Docker Compose configuration exposes the application on port `3030`.

Open:

```text
http://<server>:3030/wifi/
```

For production, expose the application through HTTPS via a reverse proxy instead of directly publishing this port to an untrusted network.

---

# ⚙️ Configuration

Example configuration:

```dotenv
EMAIL_ADMIN=admin@example.com
EMAIL_SUBJECT=WiFi Voucher

SMTP_HOST=mail.example.com
SMTP_PORT=587
SMTP_USER=voucher@example.com
SMTP_FROM="WiFi Voucher <voucher@example.com>"
SMTP_PASS=your-smtp-password
SMTP_TLS=false

OPNSENSE_HOST=firewall.example.com
OPNSENSE_PORT=443

API_USERNAME=your-opnsense-api-key
API_PASSWORD=your-opnsense-api-secret

ALLOW_SELFSIGNED_HTTPS_CERTS=false

CAPTIVE_PORTAL_URL=https://wifi.example.com/
BASEPATH=/wifi/
```

## Configuration reference

| Variable                       | Description                                   |
| ------------------------------ | --------------------------------------------- |
| `EMAIL_ADMIN`                  | BCC address for voucher emails (optional)     |
| `EMAIL_SUBJECT`                | Subject used for voucher emails               |
| `SMTP_HOST`                    | SMTP server hostname (empty = email disabled) |
| `SMTP_PORT`                    | SMTP server port                              |
| `SMTP_USER`                    | SMTP username                                 |
| `SMTP_FROM`                    | Sender address                                |
| `SMTP_PASS`                    | SMTP password                                 |
| `SMTP_TLS`                     | SMTP TLS configuration                        |
| `OPNSENSE_HOST`                | OPNsense hostname or IP (legacy: `HOSTNAME`)  |
| `OPNSENSE_PORT`                | OPNsense WebGUI/API port (optional, default 443) |
| `API_USERNAME`                 | OPNsense API key                              |
| `API_PASSWORD`                 | OPNsense API secret                           |
| `PROVIDER`                     | Captive Portal voucher server name (default `Voucher Server`) |
| `ALLOW_SELFSIGNED_HTTPS_CERTS` | Allow self-signed OPNsense HTTPS certificates |
| `CAPTIVE_PORTAL_URL`           | Captive Portal URL presented to guests        |
| `BASEPATH`                     | VoucherBox URL prefix                         |

---

# 🎟️ How VoucherBox Works

The basic workflow is:

```text
Operator
   │
   │ opens VoucherBox
   ▼
VoucherBox
   │
   │ OPNsense API
   ▼
OPNsense Captive Portal
   │
   │ creates voucher
   ▼
Voucher
   │
   ├── Displayed to operator
   ├── QR code
   └── Optional email
```

OPNsense remains responsible for the actual Captive Portal and voucher authentication.

VoucherBox is an interface around that functionality.

---

# 📧 Email Delivery

Email is optional. When it is off, the email field is hidden and the voucher (username, password, QR code) is shown on the page only. If sending fails, the voucher is still returned and shown with a warning.

There are two ways to configure SMTP:

- **From the Settings page** (admins): host, port, implicit TLS, username, password, sender, BCC and subject, plus a *Send test email* button. The SMTP password is encrypted in the database with AES-256-GCM using `SETTINGS_ENCRYPTION_KEY` (at least 32 characters, kept outside the database, e.g. in a Kubernetes Secret). The API never returns it: leave the field empty to keep the stored one. Without `SETTINGS_ENCRYPTION_KEY` a password cannot be stored. If the key changes, the stored password can no longer be decrypted and must be entered again.
- **From environment variables**: when `SMTP_HOST` is set, SMTP is managed by the deployment and shown read-only in Settings:

```dotenv
SMTP_HOST=mail.example.com
SMTP_PORT=587
SMTP_USER=voucher@example.com
SMTP_PASS=...
SMTP_FROM="WiFi Voucher <voucher@example.com>"
SMTP_TLS=false
EMAIL_ADMIN=admin@example.com
EMAIL_SUBJECT=WiFi Voucher
```

`SMTP_USER` empty = relay without authentication.

## Email content and terms

Admins edit the voucher email under **Settings → Voucher email & terms**: title, introduction, instructions, signature, labels, date locale and time zone, QR code on/off and caption, optional login button. The texts are plain text with placeholders `{{username}}` `{{password}}` `{{validity}}` `{{expiryDate}}` `{{loginLink}}`: HTML is escaped and unknown placeholders are rejected. The layout is fixed and email-client friendly. There is a live preview, a *Send sample* button and *Reset to default*.

- The QR code is attached as an inline image (`cid:`), because Gmail and other clients block `data:` images. Every email also has a plain-text part.
- The login button is off by default: a link to the captive portal with the password in the URL is often flagged as phishing by spam filters.
- **Terms and conditions**, if set, appear at the bottom of the email and on the voucher page. There the operator must confirm that the guest accepted them before a voucher can be created. The history records the acceptance and a version id of the exact text, and admins can look up that text from the History tab.

Advanced: `EMAIL_TEMPLATE_PATH` points to a custom MJML/Handlebars template file that replaces the layout (variables `{{username}}`, `{{password}}`, `{{validity}}`, `{{expiryDate}}`, `{{loginLink}}`, `{{qrCode}}`).

---

# 🗂️ Voucher History

Every created voucher is stored in a SQLite database in `DATA_DIR` (default `/app/data` in the container, mount a volume there): date, voucher username, voucher group, validity, expiry, email (if any), whether the email was sent, and the logged-in operator (with OIDC). **Voucher passwords are never stored.**

Admins can browse, filter and export it as CSV from the **History** tab. Entries older than the retention period are deleted automatically: the default comes from `HISTORY_RETENTION_DAYS` (365) and admins can change it under **Settings** (0 = keep forever). Email addresses are personal data: choose a retention period that fits your privacy policy.

---

# 📜 Syslog

Admins can forward events to a syslog server from **Settings** (host, port, UDP/TCP/TLS, facility, app name, hostname) and send a test message. Messages are RFC 5424 with a JSON body, e.g.:

```text
<134>1 2026-09-28T22:54:04.812Z voucherbox-vlan20 voucherbox 1 voucher.created - {"event":"voucher.created","username":"...","vouchergroup":"...","validityHours":4,"email":null,"emailSent":false,"operator":"alice"}
```

Events: `voucher.created` and `settings.updated`. The voucher password is never sent.

---

# 🔐 Login: Local Users and OIDC (Keycloak)

`AUTH_MODE` selects how users sign in:

| `AUTH_MODE` | Behaviour |
| --- | --- |
| `none` | No login, every visitor is an admin. Default when `OIDC_ISSUER_URL` is not set (backward compatible): keep it behind an authenticating reverse proxy |
| `local` | Local users stored in the database |
| `oidc` | OpenID Connect only (Keycloak, Authentik, ...). Default when `OIDC_ISSUER_URL` is set |
| `local+oidc` | Both: username/password form plus a single sign-on button |

Roles: **user** creates vouchers; **admin** also sees History, Settings and (with local login) Users.

## Local users

- On first start, `LOCAL_ADMIN_USERNAME` (default `admin`) is created as admin with `LOCAL_ADMIN_PASSWORD` (at least 10 characters). The app refuses to start in `local` mode with no users and no `LOCAL_ADMIN_PASSWORD`.
- Later changes to `LOCAL_ADMIN_PASSWORD` are ignored, so a password changed in the UI is kept. To recover a lost password, start once with `LOCAL_ADMIN_RESET_PASSWORD=true`.
- Admins manage users under **Users**: create, change role, disable, set a password, delete. The last active admin cannot be demoted, disabled or deleted. Users change their own password under **Account**.
- Passwords are hashed with scrypt. After 5 failed logins an account is locked for 15 minutes, and too many failures from the same IP are throttled. Role and disabled status are checked on every request.
- The session cookie is signed with `SESSION_SECRET`, or with a random secret generated once and stored in the database.

## OIDC

| Variable | Description |
| --- | --- |
| `OIDC_ISSUER_URL` | Issuer URL, e.g. `https://auth.example.com/realms/example` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | Confidential client (secret optional for public clients; PKCE is always used) |
| `PUBLIC_URL` | Public URL including the base path, e.g. `https://voucher.example.com/wifi`. Redirect URI: `<PUBLIC_URL>/auth/callback` |
| `OIDC_USER_ROLE` | Role required to use the app (empty = any authenticated user) |
| `OIDC_ADMIN_ROLE` | Role required for History and Settings (empty = any authenticated user) |
| `OIDC_SCOPES` | Default `openid profile email` |
| `OIDC_ALLOW_SELFSIGNED_HTTPS_CERTS` | `true` to accept a self-signed IdP certificate |

Common: `SESSION_SECRET` (optional, at least 32 characters) and `SESSION_MAX_AGE_HOURS` (default 8).

Roles are read from Keycloak's `realm_access.roles` and `resource_access.<client>.roles`, and from `groups` / `roles` claims. In Keycloak: create a confidential OpenID Connect client with redirect URI `<PUBLIC_URL>/auth/callback` and post-logout redirect URI `<PUBLIC_URL>/`, then create the roles and assign them to users or groups. `/healthz` stays reachable without login for health checks.

---

# 🛠️ Development

The project consists of two main components:

```text
.
├── backend/
│   ├── src/
│   └── email templates
│
├── frontend/
│   ├── src/
│   └── React application
│
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── logo.svg
└── package.json
```

Install dependencies:

```bash
npm install
npm --prefix frontend install
npm --prefix backend install
```

Start development:

```bash
npm run dev
```

Build:

```bash
npm run build
```

---

# 🐞 Troubleshooting

## VoucherBox does not start

Check:

```bash
docker compose ps
docker compose logs -f
```

Verify that your `.env` file exists and contains the required values.

---

## OPNsense API authentication fails

Check:

1. `OPNSENSE_HOST` / `OPNSENSE_PORT`
2. API key
3. API secret
4. OPNsense connectivity
5. OPNsense HTTPS certificate
6. User/group privileges
7. Effective privileges

If the API key was lost, create a new one. OPNsense does not make the API secret available again after its initial creation.

---

## Voucher generation returns an authorization error

The API account probably does not have the required privilege.

Go to:

**System → Access → Privileges**

and inspect the effective privileges of the VoucherBox account.

Do **not** immediately solve this by granting `All pages`.

Instead, identify the exact OPNsense API resource required by the VoucherBox operation and grant the smallest appropriate privilege.

---

## Emails are not sent

Check:

```text
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASS
SMTP_FROM
SMTP_TLS
```

Then inspect:

```bash
docker compose logs -f
```

Also verify that the VoucherBox container can establish a connection to the SMTP server.

---

# 🧩 Technology

### Frontend

* React
* TypeScript
* Vite
* Tailwind CSS

### Backend

* Node.js
* TypeScript
* Express
* Nodemailer
* MJML
* QRCode

### Deployment

* Docker
* Docker Compose
* Node.js Alpine

---

# 🤝 Contributing

Pull requests and improvements are welcome.

Before submitting a pull request:

1. Keep changes focused.
2. Run the project build.
3. Test against an OPNsense test installation where possible.
4. Do not commit credentials or secrets.
5. Document configuration changes.
6. Consider backward compatibility when changing environment variables or API behavior.

For larger changes, open an issue first to discuss the proposed approach.

---

# 📚 Documentation & References

### OPNsense

* [OPNsense — Local Users & Groups](https://docs.opnsense.org/manual/how-tos/user-local.html)
* [OPNsense — Access / User Management](https://docs.opnsense.org/manual/users.html)
* [OPNsense — Using the API](https://docs.opnsense.org/development/how-tos/api.html)
* [OPNsense — API Reference](https://docs.opnsense.org/development/api.html)
* [OPNsense — Captive Portal](https://docs.opnsense.org/manual/captiveportal.html)

---

# 📄 License

Published under MIT license.
