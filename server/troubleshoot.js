import dns from "node:dns/promises";
import { pingHost, tcpOpen } from "./probe.js";

const PORTS = [
  [22, "SSH"],
  [80, "HTTP"],
  [443, "HTTPS"],
  [3389, "Remote Desktop"],
  [445, "File sharing"],
  [5985, "WinRM"],
];

export function osFamily(os) {
  const text = String(os || "").toLowerCase();
  if (/win/.test(text)) return "windows";
  if (/mac|darwin|os x/.test(text)) return "mac";
  if (/linux|ubuntu|debian|centos|red hat|rhel|fedora|sles/.test(text)) return "linux";
  return "unknown";
}

export function remoteCommands(family) {
  if (family === "windows") {
    return [
      { title: "Network", command: "ipconfig /all" },
      { title: "Internet test", command: "ping -n 4 8.8.8.8" },
      { title: "DNS test", command: "nslookup osviatech.com" },
      { title: "Disk space", command: "Get-PSDrive -PSProvider FileSystem | Format-Table Name,Used,Free" },
      { title: "Memory and CPU", command: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name,CPU,WorkingSet" },
      { title: "Stopped auto services", command: "Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } | Format-Table Name,Status" },
      { title: "Recent errors", command: "Get-WinEvent -FilterHashtable @{LogName='System'; Level=2} -MaxEvents 20 | Format-List TimeCreated,Id,Message" },
      { title: "Windows version", command: "systeminfo | findstr /B /C:\"OS Name\" /C:\"OS Version\" /C:\"System Boot Time\"" },
    ];
  }
  if (family === "linux") {
    return [
      { title: "Network", command: "ip -br addr" },
      { title: "Internet test", command: "ping -c 4 8.8.8.8" },
      { title: "DNS test", command: "getent hosts osviatech.com" },
      { title: "Disk space", command: "df -h" },
      { title: "Memory", command: "free -h" },
      { title: "Load", command: "uptime; ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -n 16" },
      { title: "Failed services", command: "systemctl --failed" },
      { title: "Recent errors", command: "journalctl -p err -n 30 --no-pager" },
    ];
  }
  if (family === "mac") {
    return [
      { title: "Network", command: "ifconfig" },
      { title: "Internet test", command: "ping -c 4 8.8.8.8" },
      { title: "DNS test", command: "dscacheutil -q host -a name osviatech.com" },
      { title: "Disk space", command: "df -h" },
      { title: "Memory", command: "vm_stat; top -l 1 -n 15 -o cpu" },
    ];
  }
  return [
    { title: "Identity", command: "hostname; uname -a || ver" },
    { title: "Internet test", command: "ping -c 4 8.8.8.8 || ping -n 4 8.8.8.8" },
  ];
}

export function playbooks(device) {
  const ready = Boolean(device.mesh_node_id && device.consent_at && device.organization_status === "active");
  const online = device.reachability === "online";
  return [
    {
      id: "offline",
      title: "Device looks offline",
      when: "The customer says it is on, but the portal shows offline or MeshCentral is disconnected.",
      steps: [
        "Check from the OSVIA server (Diagnose). If ping fails, the path to the site is down or the address is wrong.",
        "Ask the customer to confirm power, network cable or Wi-Fi, and whether other PCs at the site work.",
        "If MeshCentral was online recently, open a remote session as soon as the agent reconnects.",
        "If this is a MeshCentral device, run Sync MeshCentral — status comes from the agent, not from ping.",
      ],
      mode: ready ? "desktop" : null,
    },
    {
      id: "slow",
      title: "Slow or freezing",
      when: "The PC is on but staff cannot work.",
      steps: [
        "Open Remote desktop to see the screen, or Terminal if the desktop will not load.",
        "Paste the CPU and disk commands below. Look for one process using most of the CPU or a disk that is full.",
        "Check Windows Update or a backup job that is running.",
        "Record what you found so the next technician does not repeat the same checks.",
      ],
      mode: ready && online ? "desktop" : ready ? "terminal" : null,
    },
    {
      id: "internet",
      title: "No internet at the site",
      when: "Browsers fail or email cannot send, but the PC itself is on.",
      steps: [
        "Diagnose from the OSVIA server. If we can reach the public address, the problem is inside the office LAN or DNS.",
        "In Terminal, run the network and DNS commands. Note the default gateway and DNS servers.",
        "Ping 8.8.8.8. If that works but names fail, it is DNS. If that fails, it is the WAN or router.",
        "Open Files only if you need a screenshot or a saved report from the desktop.",
      ],
      mode: ready ? "terminal" : null,
    },
    {
      id: "printer",
      title: "Printer or shared folder",
      when: "Printing fails or a share cannot be opened.",
      steps: [
        "Open Remote desktop so you can see the exact error the user sees.",
        "Confirm the printer or share name, and whether other users at the site can print.",
        "For Windows, check Devices and Printers and the print spooler. For a share, try \\\\server\\share from File Explorer.",
        "Use Files if you need to collect a test print PDF or a screenshot.",
      ],
      mode: ready ? "desktop" : null,
    },
    {
      id: "signin",
      title: "Cannot sign in",
      when: "Wrong password, locked account, or a domain that will not accept the user.",
      steps: [
        "Open Remote desktop or Terminal with a local admin account if the user profile is locked.",
        "Do not reset a password in this portal. Use the organization's directory or ask the customer admin.",
        "Check the clock on the PC — a wrong date breaks domain sign-in.",
        "Record the account name and the exact error. Never store a password in notes.",
      ],
      mode: ready ? "desktop" : null,
    },
    {
      id: "disk",
      title: "Disk full or files missing",
      when: "Windows warns about space, or a file the customer needs is gone.",
      steps: [
        "Open Terminal and run the disk-space command. Note the free space on C: or /.",
        "Open Files to inspect Downloads, Recycle Bin, or a large folder the customer names.",
        "Do not delete files without the customer's agreement. Record what you removed and why.",
      ],
      mode: ready ? "files" : null,
    },
  ].map((item) => ({ ...item, available: Boolean(item.mode) }));
}

export function blockers(device) {
  const items = [];
  if (device.organization_status !== "active") items.push("The organization is not active, so remote support is blocked.");
  if (!device.mesh_node_id) items.push("This device is not linked to a MeshCentral agent. You can still diagnose from the OSVIA server and ask the customer to install the agent.");
  if (device.mesh_node_id && !device.consent_at) items.push("The customer has not given remote-support consent. Ask their administrator to allow it on this device.");
  if (device.reachability === "offline") items.push("The last verified check was offline. A remote session will only connect if the MeshCentral agent is back.");
  if (!device.address && device.source !== "meshcentral") items.push("No IP or host name is set, so the OSVIA server cannot ping this device.");
  return items;
}

async function resolveHost(host) {
  try {
    const result = await dns.lookup(host, { all: false });
    return { ok: true, address: result.address };
  } catch {
    return { ok: false, address: null, error: "The name did not resolve from the OSVIA server." };
  }
}

export async function diagnoseHost(host, extraPort = null) {
  const target = String(host || "").trim();
  const ports = [...PORTS];
  if (extraPort && !ports.some(([port]) => port === extraPort)) ports.push([extraPort, `Port ${extraPort}`]);
  const [lookup, ping, ...portResults] = await Promise.all([
    resolveHost(target),
    pingHost(target).then((ok) => ({ ok })),
    ...ports.map(async ([port, name]) => ({ port, name, open: await tcpOpen(target, port, 1500) })),
  ]);
  return {
    from: "OSVIA server",
    notice: "These results are from the OSVIA server to this address. They are not readings from inside the computer.",
    host: target,
    dns: lookup,
    ping,
    ports: portResults,
  };
}

export function packTroubleshoot(device) {
  const family = osFamily(device.operating_system);
  return {
    family,
    commands: remoteCommands(family),
    playbooks: playbooks(device),
    blockers: blockers(device),
    canRemote: Boolean(device.mesh_node_id && device.consent_at && device.organization_status === "active"),
    canDiagnose: Boolean(device.address || device.last_seen_ip),
  };
}
