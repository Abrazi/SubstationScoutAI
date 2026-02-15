# Starting the Relay with Port 102 Privileges

Port 102 (IEC 61850 MMS) is a **privileged port** on Linux (< 1024) and requires special handling.

## Solution Options:

### Option 1: Run with sudo (Quick & Simple)
```bash
sudo npm run relay
```

**Pros:** Works immediately  
**Cons:** Entire Node.js process runs as root (security concern)

---

### Option 2: Grant CAP_NET_BIND_SERVICE to Node.js (Recommended)
This allows Node.js to bind to privileged ports without running as root.

```bash
# Find your Node.js binary path
which node
# Usually: /usr/bin/node or similar

# Grant the capability
sudo setcap 'cap_net_bind_service=+ep' $(which node)

# Now you can run normally
npm run relay
```

**Pros:** Most secure, only grants port binding capability  
**Cons:** Must be reapplied after Node.js updates

---

### Option 3: Use Port Forwarding (Alternative)
Relay binds to unprivileged port, iptables forwards 102 → higher port.

```bash
# Change relay to use port 10102 instead
# Then use iptables to forward:
sudo iptables -t nat -A PREROUTING -p tcp --dport 102 -j REDIRECT --to-port 10102
```

**Pros:** Relay doesn't need privileges  
**Cons:** More complex, requires iptables knowledge

---

### Option 4: Modify Relay to Use Unprivileged Ports (Development Only)
Change ports in code to test without privileges:
- IEC MMS: 102 → 10102
- Modbus: 502 → 5020

---

## Recommended Setup (Option 2):

```bash
# 1. Stop any running relay
pkill -f "modbus-relay"

# 2. Grant Node.js the capability
sudo setcap 'cap_net_bind_service=+ep' $(which node)

# 3. Start relay normally
npm run relay

# 4. Verify relay can bind to port 102
ss -tlnp | grep :102

# 5. Test external connectivity
# From external client:
nc -zv 172.16.21.12 102
```

## Quick Test:
```bash
# Start with sudo to verify everything else works
sudo npm run relay

# In another terminal, test from external client
# If this works, the only issue was privileges
```

## Verify Capabilities:
```bash
# Check if Node.js has the capability
getcap $(which node)
# Should show: cap_net_bind_service=ep

# To remove capability later:
sudo setcap -r $(which node)
```
