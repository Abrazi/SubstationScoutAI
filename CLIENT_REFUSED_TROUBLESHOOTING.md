# IEC 61850 Client "Connection Refused" Troubleshooting

## Current Status ✓
- ✅ Relay running on 172.16.21.12:102
- ✅ Endpoint status: **active** (simulation mode)
- ✅ Diagnostic test passed (ping, TCP, COTP handshake all work)
- ❌ Actual IEC 61850 client software: "connection refused"

## Why This Happens

### Most Common Causes:

### 1. **Client Configured to Wrong Address**
Your IEC 61850 client may be trying to connect to:
- ❌ `127.0.0.1:102` or `localhost:102` (wrong - that's your Windows PC)
- ❌ `172.16.21.12:8102` (wrong port)
- ❌ Different IP entirely
- ✅ Must be: `172.16.21.12:102`

**FIX:** Check your client software configuration:
- Server IP/Address: `172.16.21.12`
- Port: `102`
- Protocol: IEC 61850 MMS (not HTTP, not GOOSE)

---

### 2. **Client Using IPv6 Instead of IPv4**
Some clients try IPv6 first, which may not work.

**FIX:** Force IPv4 in client settings if available.

---

### 3. **Client Software Expects TLS/Secure Connection**
The relay only supports plain TCP, not TLS/SSL.

**FIX:** Disable "Secure MMS" or "TLS" in client settings.

---

### 4. **Windows Firewall Blocking Outbound**
Your Windows PC firewall may block outbound connections to port 102.

**FIX:** 
```powershell
# Run as Administrator in PowerShell
New-NetFirewallRule -DisplayName "IEC 61850 MMS Outbound" -Direction Outbound -LocalPort 102 -Protocol TCP -Action Allow
```

---

### 5. **Client Trying Wrong Network Interface**
If your Windows PC has multiple network adapters (WiFi + Ethernet), it may be using the wrong one.

**FIX:** Disable other network adapters temporarily, or set static route:
```powershell
# Check which adapter reaches 172.16.21.12
route print | findstr 172.16.21.12
```

---

## Debugging Steps

### Step 1: Verify Client Configuration
In your IEC 61850 client software, find the connection settings and verify:
- [ ] IP Address: `172.16.21.12`
- [ ] Port: `102`
- [ ] Protocol: MMS (not GOOSE, not SV)
- [ ] No TLS/SSL enabled
- [ ] No authentication required

### Step 2: Test Connection While Monitoring
**On Linux server (this machine), run:**
```bash
tail -f relay.log
```

**On Windows client, attempt connection.**

**Watch for:**
- ✅ If you see: `[relay] IEC client connected: 172.16.0.156:xxxxx -> 172.16.21.12:102`
  - Connection IS reaching the server!
  - Problem is application-level, not network
  
- ❌ If you see: Nothing
  - Connection not reaching server
  - Check client IP/port configuration

### Step 3: Packet Capture on Server
```bash
sudo tcpdump -i eno1 'host 172.16.0.156 and port 102' -n
```

**Attempt connection from client. You should see:**
```
SYN packets from 172.16.0.156.xxxxx > 172.16.21.12.102
SYN-ACK from 172.16.21.12.102 > 172.16.0.156.xxxxx
```

If you see SYN but no SYN-ACK → relay issue (but unlikely, since diagnostic worked)
If you see nothing → client not sending to correct address

### Step 4: Test from Windows Command Line
On your Windows PC, test basic TCP:
```powershell
Test-NetConnection -ComputerName 172.16.21.12 -Port 102
```

Should show:
```
TcpTestSucceeded : True
```

If False → routing or firewall issue on Windows side

---

## Quick Fixes to Try

### Fix 1: Restart IEC Client Software
Close completely and reopen. Some clients cache connection failures.

### Fix 2: Use IP Instead of Hostname
If you're using a hostname like "ied.local", change to `172.16.21.12` directly.

### Fix 3: Check Client Logs
Most IEC 61850 clients have debug logs. Enable verbose logging and check for:
- "Connection refused"
- "Connection timeout"  
- "No route to host"
- "TLS handshake failed"
- "Authentication failed"

### Fix 4: Try Different Client Software
To isolate the issue, try a different IEC 61850 tool if available:
- IEDScout
- IEC 61850 Client Simulator
- OpenMUC

---

## Common IEC 61850 Client Software Issues

### **IEDScout / SystemCORP**
- Check: "Use TLS" should be UNCHECKED
- Check: Authentication should be NONE
- Check: Connection timeout - increase to 30 seconds

### **Omicron / OMICRON IEDScout**
- May require .ICD file even to connect
- Try importing a generic ICD first

### **SIEMENS DIGSI**
- Verify IP is in "Online Connections" not "Project Connections"

### **ABB PCM600**
- May only work with ABB devices
- Check "Direct Connection" vs "Project mode"

---

## What to Check Next

1. **Run this on Linux server while attempting connection:**
   ```bash
   tail -f relay.log
   ```

2. **What do you see in client software error?**
   - Exact error message?
   - Screenshot of connection settings?
   - Client log output?

3. **Test TCP from Windows:**
   ```powershell
   Test-NetConnection 172.16.21.12 -Port 102
   ```

4. **Client software name and version?**
   - Different tools have different quirks

---

## Still Not Working?

Provide these details:
1. IEC 61850 client software name and version
2. Exact error message from client
3. Output of: `tail -f relay.log` while attempting connection
4. Output of Windows: `Test-NetConnection 172.16.21.12 -Port 102`
5. Screenshot of client connection settings

The diagnostic test PASSED, so the network works. The issue is likely:
- Client configured to wrong address
- Client software compatibility issue
- Client expecting features not in simulation mode (data model, etc.)
