
/**
 * Modbus TCP Protocol Handler
 */

function buildAdu(transId, unitId, pdu) {
    const mbap = Buffer.alloc(7);
    mbap.writeUInt16BE(transId & 0xffff, 0);
    mbap.writeUInt16BE(0, 2); // protocol id
    mbap.writeUInt16BE(pdu.length + 1, 4); // unit id + pdu
    mbap.writeUInt8(unitId & 0xff, 6);
    return Buffer.concat([mbap, pdu]);
}

function parsePdu(transId, unitId, pdu) {
    if (pdu.length < 1) return null;
    const fc = pdu.readUInt8(0);

    if ([1, 2, 3, 4].includes(fc)) {
        if (pdu.length < 5) return null;
        const addr = pdu.readUInt16BE(1);
        const len = pdu.readUInt16BE(3);
        return { transId, unitId, fc, addr, len };
    }

    if (fc === 5) {
        if (pdu.length < 5) return null;
        const addr = pdu.readUInt16BE(1);
        const raw = pdu.readUInt16BE(3);
        const val = raw === 0xff00 ? 1 : 0;
        return { transId, unitId, fc, addr, val };
    }

    if (fc === 6) {
        if (pdu.length < 5) return null;
        const addr = pdu.readUInt16BE(1);
        const val = pdu.readUInt16BE(3);
        return { transId, unitId, fc, addr, val };
    }

    return { transId, unitId, fc, addr: 0, len: 0 };
}

function buildExceptionResponse(transId, unitId, fc, exCode) {
    const pdu = Buffer.from([fc | 0x80, exCode & 0xff]);
    return buildAdu(transId, unitId, pdu);
}

function buildReadResponse(transId, unitId, fc, data) {
    const values = Array.isArray(data) ? data : [];

    if (fc === 1 || fc === 2) {
        const byteCount = Math.ceil(values.length / 8);
        const bytes = Buffer.alloc(byteCount, 0);
        values.forEach((value, idx) => {
            if (Number(value)) bytes[Math.floor(idx / 8)] |= 1 << (idx % 8);
        });
        const pdu = Buffer.concat([Buffer.from([fc, byteCount]), bytes]);
        return buildAdu(transId, unitId, pdu);
    }

    const byteCount = values.length * 2;
    const payload = Buffer.alloc(byteCount);
    values.forEach((value, idx) => {
        payload.writeUInt16BE((Number(value) || 0) & 0xffff, idx * 2);
    });
    const pdu = Buffer.concat([Buffer.from([fc, byteCount]), payload]);
    return buildAdu(transId, unitId, pdu);
}

function buildWriteEchoResponse(transId, unitId, fc, addr, val) {
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(fc, 0);
    pdu.writeUInt16BE(addr & 0xffff, 1);
    if (fc === 5) {
        pdu.writeUInt16BE(Number(val) ? 0xff00 : 0x0000, 3);
    } else {
        pdu.writeUInt16BE((Number(val) || 0) & 0xffff, 3);
    }
    return buildAdu(transId, unitId, pdu);
}

module.exports = {
    parsePdu,
    buildExceptionResponse,
    buildReadResponse,
    buildWriteEchoResponse,
    buildAdu
};
