#!/bin/bash

# IEC 61850 External Client Connectivity Test
# Run this script FROM THE EXTERNAL CLIENT MACHINE

SERVER_IP="172.16.21.12"
SERVER_PORT="102"

echo "=== Testing Connectivity to IEC 61850 Server ==="
echo "Server: $SERVER_IP:$SERVER_PORT"
echo ""

# Step 1: Basic network connectivity
echo "[1/5] Testing ping (ICMP)..."
if ping -c 3 -W 2 $SERVER_IP > /dev/null 2>&1; then
    echo "  ✓ Ping successful - server is reachable"
else
    echo "  ✗ Ping FAILED - server unreachable or ICMP blocked"
    echo "  → Check network connectivity, routing, or firewall"
fi

echo ""

# Step 2: Route check
echo "[2/5] Checking route to server..."
echo "  Route:"
ip route get $SERVER_IP 2>/dev/null | head -1 || echo "  → Cannot determine route"

echo ""

# Step 3: TCP connectivity test
echo "[3/5] Testing TCP connection to port $SERVER_PORT..."
if command -v nc &> /dev/null; then
    if timeout 3 nc -zv $SERVER_IP $SERVER_PORT 2>&1 | grep -q "succeeded\|Connected"; then
        echo "  ✓ TCP connection successful"
    else
        echo "  ✗ TCP connection FAILED"
        echo "  → Port may be filtered by firewall or not listening"
    fi
else
    echo "  ⚠ 'nc' not available, skipping"
fi

echo ""

# Step 4: Telnet test
echo "[4/5] Testing with telnet..."
if command -v telnet &> /dev/null; then
    (echo "QUIT"; sleep 1) | timeout 3 telnet $SERVER_IP $SERVER_PORT 2>&1 | head -5
    echo ""
else
    echo "  ⚠ 'telnet' not available, skipping"
fi

# Step 5: MMS protocol test (if we can connect)
echo "[5/5] Attempting MMS COTP handshake..."
if command -v xxd &> /dev/null && command -v nc &> /dev/null; then
    # Send COTP Connection Request
    RESPONSE=$(printf '\x03\x00\x00\x16\x11\xe0\x00\x00\x00\x01\x00\xc1\x02\x01\x00\xc2\x02\x01\x02\xc0\x01\x09' | timeout 2 nc $SERVER_IP $SERVER_PORT | xxd)
    
    if [ -n "$RESPONSE" ]; then
        echo "  ✓ Received MMS response:"
        echo "$RESPONSE" | head -3
        
        # Check if it's a valid COTP Connection Confirm (0xD0)
        if echo "$RESPONSE" | grep -q "d0"; then
            echo "  ✓✓ Valid COTP Connection Confirm detected!"
            echo "  → IEC 61850 server is responding correctly"
        else
            echo "  ⚠ Response received but may not be valid COTP"
        fi
    else
        echo "  ✗ No response to MMS handshake"
        echo "  → Connection may timeout or server not responding to MMS"
    fi
else
    echo "  ⚠ 'xxd' or 'nc' not available, skipping"
fi

echo ""
echo "=== Summary ==="
echo ""
echo "If all tests passed:"
echo "  → Your IEC 61850 client should be able to connect"
echo ""
echo "If ping works but TCP fails:"
echo "  → Firewall is blocking port $SERVER_PORT"
echo "  → Server may not be listening on this interface"
echo ""
echo "If TCP works but MMS fails:"
echo "  → Server accepted connection but protocol issue"
echo "  → Check server logs for connection attempts"
echo ""
echo "If nothing works:"
echo "  → Network routing issue"
echo "  → Different subnet/VLAN"
echo "  → Check with: traceroute $SERVER_IP"
