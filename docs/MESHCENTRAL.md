# MeshCentral integration

> **Status:** the portal includes a local MeshCentral setup in `meshcentral/`. On this office PC it runs at `https://127.0.0.1:4430`. Certificates, the MeshCentral database, the agent, and login keys are created on the server and are not in git. Other sites still need their own URL and agent.

## What the portal does

The portal does not talk to MeshCentral's internal APIs. It runs the official `meshctrl.js` command-line tool that ships with the `meshcentral` npm package, and it only uses these commands:

| Purpose | Command |
| --- | --- |
| Health check | `meshctrl serverinfo --json` |
| Device sync | `meshctrl listdevices --id <device group id> --json` |

For remote support it builds a link of the form `MESHCENTRAL_URL/?gotonode=<node id>&viewmode=<10-13>` and opens it in the technician's browser. The technician still signs in to MeshCentral with their own MeshCentral account. The portal never sends MeshCentral credentials to the browser.

Device sync updates name, operating system and the agent connection state (`conn`) for devices in each organization's mapped device group. A device is shown as online only when MeshCentral reports an agent connection. Devices already mapped to another organization are never moved.

## Remote support rules

A technician or administrator can open a remote session only when all of these are true. The server checks every one:

- they have two-factor authentication turned on;
- the organization is active (not suspended);
- the device is linked to a MeshCentral node;
- a customer administrator has recorded consent for that device (they can revoke it at any time);
- they enter a reason.

Each launch is stored in the device's remote-session history and the audit log, and the customer administrators get a notification. Nothing in the portal hides the MeshCentral agent or bypasses the customer's own security tools.

## Setup

The `meshcentral/` folder in this repo is the local server: `package.json`, `config.example.json`, and `start-meshcentral.cmd`. From that folder run `npm install`, then `start-meshcentral.cmd`. The first start copies the example config and creates certificates. Point the portal `.env` at `https://127.0.0.1:4430` and `wss://127.0.0.1:4430`, and set `MESHCTRL_TLS_INSECURE=true` for that self-signed certificate.

1. Install MeshCentral on the server (the included folder, or `docker compose --profile meshcentral up -d`) and finish its own setup in the browser.
2. Get `meshctrl.js`: `npm install meshcentral` in a folder outside the portal, for example `/opt/meshctrl`. The file is `node_modules/meshcentral/meshctrl.js`.
3. Run `node meshctrl.js --help` and confirm that your version supports `serverinfo`, `listdevices --id`, `--loginuser`, `--loginkeyfile` and `--logindomain`. If any option differs, stop and adjust `server/meshcentral.js` before going further.
4. Create a dedicated MeshCentral user for the portal with read access to the customer device groups only.
5. Preferred: create a login key file on the MeshCentral server (see the MeshCentral guide for `--logintokenkey`), store it where only the portal user can read it, and set `MESHCENTRAL_LOGINKEY_FILE`. Alternative: put the account password in a file and set `MESHCENTRAL_PASSWORD_FILE`. In that case `meshctrl` receives the password as a command-line argument, so other local users of the machine could see it in the process list.
6. Set in `.env`:

   ```ini
   MESHCENTRAL_URL=https://mesh.osviatech.com
   MESHCENTRAL_CONTROL_URL=wss://mesh.osviatech.com:443
   MESHCTRL_PATH=/opt/meshctrl/node_modules/meshcentral/meshctrl.js
   MESHCENTRAL_USER=portal-sync
   MESHCENTRAL_LOGINKEY_FILE=/etc/osvia/mesh-login.key
   MESH_SYNC_MINUTES=5
   ```

7. Restart the portal, then **Settings → System → Check MeshCentral**. It must show *Healthy*.
8. In MeshCentral, copy each customer's device group id (it starts with `mesh/`). In the portal open the organization, choose **Edit**, and paste it into *MeshCentral group*.
9. Choose **Sync MeshCentral** on the Devices page, or wait for the next scheduled sync, and confirm the devices appear with the correct online state.
