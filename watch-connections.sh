#!/bin/bash

echo "=== IEC 61850 Connection Monitor ==="
echo "Watching for connections on 172.16.21.12:102..."
echo "Press Ctrl+C to stop"
echo ""
echo "Relay log:"
echo "---"

tail -f relay.log | grep --line-buffered -E "IEC|error|Error|ERROR|fail|Fail|FAIL"
