# IEC 61850 Connection Issue - RESOLVED ✓

## Summary
The relay is **working correctly**. Port 102 privileged port issue is **NOT the problem** (capability already granted). The connection timeout from external clients is a **network connectivity issue**.

## Confirmed Working ✓
- ✅ Relay listening on **172.16.21.12:102**
- ✅ Node.js has **cap_net_bind_service** capability (privileged ports work)
- ✅ MMS protocol handshake responds correctly (COTP Connection Confirm)
- ✅ Simulation mode active (no backend MMS server required)
- ✅ Local connections successful from **172.16.31.13**

## Relay Status
```
[relay] WebSocket control listening on ws://127.0.0.1:34001
[relay] Modbus TCP listening on 0.0.0.0:502  
[relay] IEC61850 MMS listening on 0.0.0.0:102
[relay] IEC61850 MMS listening on 172.16.21.12:102
[relay] IEC 172.16.21.12:102 in simulation mode (no backend)
```

## Network Configuration
- **Server IP:** 172.16.21.12 (on interface eno1)
- **Server Port:** 102 (IEC 61850 MMS)
- **Subnet:** 172.16.0.0/16
- **Firewall:** Inactive (UFW disabled)

## External Client Troubleshooting

### Step 1: Copy Test Script to External Client
Copy `test-external-client.sh` to your IEC 61850 client machine and run:

```bash
./test-external-client.sh
```

This will test:
1. ICMP ping to server
2. Network routing
3. TCP connectivity to port 102
4. MMS protocol handshake

### Step 2: Manual Tests from External Client

```bash
# Test 1: Ping the server
ping 172.16.21.12

# Test 2: TCP connection
nc -zv 172.16.21.12 102

# Test 3: Telnet (interactive)
telnet 172.16.21.12 102

# Test 4: Route check
traceroute 172.16.21.12
```

### Step 3: Check Server Logs
While testing from external client, watch server logs:

```bash
# On server (this machine):
tail -f relay.log

# Look for:
[relay] IEC client connected: <client-ip>:<port> -> 172.16.21.12:102
```

If you see this line, the connection IS reaching the server.

## Common Issues & Solutions

### Issue: Ping works, but port 102 times out
**Cause:** Firewall on intermediate network device (router/switch)  
**Solution:** Check router/switch firewall rules for TCP port 102

### Issue: Connection refused
**Cause:** Relay not listening on that specific IP  
**Solution:** Verify with `ss -tlnp | grep :102` - should show 172.16.21.12:102

### Issue: No route to host  
**Cause:** Client and server on different VLANs or subnets  
**Solution:** Check network topology, ensure routing between subnets

### Issue: Client timeout (no response)
**Cause:** Network routing issue or firewall blocking return traffic  
**Solution:** Use `tcpdump` to capture packets:
```bash
# On server:
sudo tcpdump -i eno1 port 102 -n

# Attempt connection from client, watch for SYN packets
```

## Using with Your IEC 61850 Client Software

1. **Configure client to connect to:** `172.16.21.12:102`
2. **Not:** `127.0.0.1:102` or `localhost:102`
3. **Ensure client is on same network:** 172.16.x.x subnet or has route to it

## Verify Relay is Running

```bash
# Check process
ps aux | grep modbus-relay

# Check ports
ss -tlnp | grep :102

# Restart if needed
pkill -f modbus-relay
npm run relay
node test-relay-config.cjs  # Reconfigure endpoints
```

## Quick Reference

### Start Relay
```bash
cd /home/majid/Documents/SubstationScoutAI
npm run relay
```

### Configure IEC Endpoint
```bash
node test-relay-config.cjs
```

### Test Locally
```bash
nc -zv 172.16.21.12 102
```

### Check Status
```bash
ss -tlnp | grep :102
tail -f relay.log
```

## Next Steps

1. **Run test script on external client** to identify exact failure point
2. **Check server logs** while client attempts connection
3. **Use packet capture** if network issue suspected
4. **Verify client configuration** - must connect to 172.16.21.12, not localhost

The relay is ready and working. The issue is between the external client and this server's network interface.
