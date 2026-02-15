#!/bin/bash

echo "=== IEC 61850 Network Binding Troubleshooting ==="
echo ""

# Check if relay is running
if pgrep -f "modbus-relay" > /dev/null; then
    echo "✓ Relay is running"
else
    echo "✗ Relay is NOT running"
    echo "  Start it with: npm run relay"
    exit 1
fi

# Check listening ports
echo ""
echo "Listening on port 102:"
ss -tlnp 2>/dev/null | grep :102 || echo "  (No listeners found)"

# Check IP assignment
echo ""
echo "Network interfaces with 172.16.21.12:"
ip addr show | grep -B 2 "172.16.21.12" || echo "  (IP not assigned to any interface)"

# Test local connectivity
echo ""
echo "Testing local connectivity to 172.16.21.12:102..."
if nc -zv 172.16.21.12 102 2>&1 | grep -q "succeeded"; then
    echo "✓ Local connection successful"
else
    echo "✗ Local connection failed"
fi

# Check firewall status
echo ""
echo "Firewall status:"
if command -v ufw &> /dev/null; then
    sudo ufw status | grep -E "Status|102" || echo "  UFW not configured for port 102"
elif command -v iptables &> /dev/null; then
    echo "  Checking iptables..."
    sudo iptables -L INPUT -n | grep -E "102|Chain" | head -5
else
    echo "  No firewall tools found"
fi

# Provide recommendations
echo ""
echo "=== Recommendations ==="
echo "1. To allow external connections through firewall:"
echo "   sudo ufw allow 102/tcp    # if using UFW"
echo "   OR"
echo "   sudo iptables -A INPUT -p tcp --dport 102 -j ACCEPT  # if using iptables"
echo ""
echo "2. From the EXTERNAL client machine, test connectivity:"
echo "   telnet 172.16.21.12 102"
echo "   OR"
echo "   nc -zv 172.16.21.12 102"
echo ""
echo "3. Watch relay logs for connection attempts:"
echo "   Relay will log: '[relay] IEC client connected: <ip>:<port> -> 172.16.21.12:102'"
echo ""
echo "4. If using the SubstationScout app, ensure:"
echo "   - Bridge is connected (Binding panel)"
echo "   - IEC 61850 endpoints are synchronized (click 'Connect IEC 61850')"
echo "   - Selected adapter includes the 172.16.21.12 IP"
