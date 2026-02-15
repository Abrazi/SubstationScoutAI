<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1FGKhfb1UFkvOTOgKKChUNYs3YyUmbhZN

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Expose Modbus + IEC 61850 to other PCs (LAN)

The browser app cannot open raw TCP servers directly. To accept external Modbus and IEC 61850 clients, run the local relay service:

1. Install deps (includes `ws`):
   `npm install`
2. Start relay (needs permission for low ports like `502` and `102`):
   `npm run relay`
3. In the app, open Modbus panel:
   - Physical Network Bridge URL: `ws://127.0.0.1:34001`
   - Click Connect
   - Select the NIC/IP used by your LAN
4. Configure device endpoints:
   - Modbus servers use each device `IP + modbusPort`.
   - IEC 61850 servers (SCL/Demo devices with Server role) use each device `IP + iecMmsPort` (default `102`).
5. Verify the **Bound Endpoints** list in the app shows each device endpoint as `ACTIVE`.

IEC bridge mode:

- IEC endpoints now run as TCP proxy listeners in relay mode.
- Each external endpoint (`deviceIp:iecMmsPort`) is bridged to a backend MMS server (`iecBackendHost:iecBackendPort`).
- Configure per-device backend in Device Configurator (SCL/Demo Server role).
- For bulk creation, backend ports auto-increment from base backend port.

### Using libiec61850 as backend

You can run one or more real MMS servers (e.g. using [mz-automation/libiec61850](https://github.com/mz-automation/libiec61850)) and point each simulated IED endpoint to the corresponding backend host/port.

For the bundled standard backend launcher, you can dynamically choose the SCD file:

- Default: `npm run iec:std:start` (uses `DUBGG.scd`)
- Custom SCD (relative path): `SCD_FILE="MyStation.scd" npm run iec:std:start`
- Custom SCD (absolute path): `SCD_FILE="/path/to/MyStation.scd" npm run iec:std:start`
- Optional IED/AP targeting from multi-IED SCD:
   - `SCD_IED_NAME="IED_A" SCD_AP_NAME="AP1" SCD_FILE="MyStation.scd" npm run iec:std:start`
- Endpoint ownership default: startup no longer pushes a hardcoded `TestIED` endpoint; the app publishes imported IED endpoints (name/IP/port) via **Network Binding → Connect IEC**.
- Backend routing default in std mode: `RELAY_FORCE_BACKEND=1` is enabled by default so imported endpoints are always proxied to the local libiec backend (prevents simulation fallback).
- Ghost-discovery prevention in std mode: `RELAY_IEC_DEFAULT_LISTENER=0` and `RELAY_CLEAR_IEC_ON_UI_DISCONNECT=1` are enabled so relay does not expose IEC endpoints unless the app publishes them, and clears IEC endpoints when app bridge disconnects.
- Control-channel hardening: relay now accepts endpoint-publish sessions only from trusted browser origins (the app UI). Headless test clients are rejected by default.
- Temporary override for diagnostics only: `RELAY_ALLOW_HEADLESS_WS=1 npm run relay`
- Optional override to allow simulation routing: `RELAY_FORCE_BACKEND=0 npm run iec:std:start`
- Optional legacy auto-endpoint injection (not recommended): `RELAY_AUTOCONFIG_ENDPOINT=1 npm run iec:std:start`

UI helper:

- In **Network Binding → IEC Device Configuration → Advanced: Backend Proxy**, set **SCD File** for each IED.
- Click **Copy Start Cmd** to copy a ready command using that SCD path.
- Run the copied command in terminal, then reconnect IEDScout.

Typical mapping example:

- External endpoint: `172.16.21.12:102` -> Backend: `127.0.0.1:8102`
- External endpoint: `172.16.21.13:102` -> Backend: `127.0.0.1:8103`

Relay will show this mapping in the IEC 61850 Endpoints panel and track live IEC client counts.

If binding to `502` fails on Linux, run with elevated privileges, for example:

`sudo npm run relay`

Optional environment overrides:

- `RELAY_WS_PORT` (default `34001`)
- `RELAY_MODBUS_PORT` / `RELAY_MODBUS_HOST` (fallback Modbus bind)
- `RELAY_IEC_MMS_PORT` / `RELAY_IEC_MMS_HOST` (fallback IEC bind)
- `RELAY_IEC_BACKEND_HOST` / `RELAY_IEC_BACKEND_PORT` (default IEC backend fallback when per-device backend is not set)
