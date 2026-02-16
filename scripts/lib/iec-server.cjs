
/**
 * IEC 61850 MMS/TPKT/COTP Protocol Handler
 */

// Helper: Build MMS GetNameList Response from IED model
function buildGetNameListResponse(iedModel) {
    if (!iedModel || !iedModel.children) {
        // Fallback: return empty list
        return Buffer.from([
            0x03, 0x00, 0x00, 0x1D,  // TPKT: version 3, length 29
            0x02,                     // COTP: length 2
            0xF0,                     // COTP: DT (Data)
            0x80,                     // COTP: EOT flag
            // MMS Confirmed-ResponsePDU
            0xA1, 0x16,              // [1] IMPLICIT SEQUENCE
            0x02, 0x01, 0x00,        // invokeID INTEGER 0
            // getNameList Response [1]
            0xA1, 0x11,              // [1] IMPLICIT SEQUENCE
            0xA0, 0x00,              // [0] IMPLICIT SEQUENCE OF (empty)
            0x81, 0x01, 0x00         // [1] BOOLEAN FALSE (moreFollows)
        ]);
    }

    // Extract Logical Devices from IED model (look for LD children)
    const logicalDevices = [];
    if (iedModel.children) {
        for (const child of iedModel.children) {
            // Check if this is a Logical Device (type === 'LD' or has LN children)
            if (child.type === 'LD' || (child.children && child.children.some(c => c.type === 'LN'))) {
                logicalDevices.push(child.name);
            }
        }
    }

    if (logicalDevices.length === 0) {
        logicalDevices.push('LD0'); // Default logical device
    }

    // Build MMS response with first LD (IEDScout will query each separately)  
    const ldName = logicalDevices[0];
    const ldNameBuf = Buffer.from(ldName, 'utf8');
    const ldNameLen = ldNameBuf.length;

    // Calculate lengths
    const identListLen = 2 + ldNameLen; // tag(1) + len(1) + name
    const responseBodyLen = 2 + identListLen + 3; // listOfIdentifier + moreFollows
    const confirmedRespLen = 3 + 2 + responseBodyLen; // invokeID + getNameList response

    const totalLen = 7 + 2 + confirmedRespLen; // TPKT/COTP + confirmed-resp

    const response = Buffer.alloc(totalLen);
    let offset = 0;

    // TPKT Header
    response[offset++] = 0x03; // Version 3
    response[offset++] = 0x00; // Reserved
    response[offset++] = (totalLen >> 8) & 0xFF;
    response[offset++] = totalLen & 0xFF;

    // COTP Header
    response[offset++] = 0x02; // Length 2
    response[offset++] = 0xF0; // DT Data
    response[offset++] = 0x80; // EOT flag

    // MMS Confirmed-ResponsePDU [1]
    response[offset++] = 0xA1; // tag
    response[offset++] = confirmedRespLen;

    // invokeID
    response[offset++] = 0x02; // INTEGER tag
    response[offset++] = 0x01; // length 1
    response[offset++] = 0x00; // value 0

    // getNameList Response [1]
    response[offset++] = 0xA1; // tag
    response[offset++] = responseBodyLen;

    // listOfIdentifier [0] SEQUENCE OF
    response[offset++] = 0xA0; // tag
    response[offset++] = identListLen;

    // Identifier (VisibleString)
    response[offset++] = 0x1A; // VisibleString tag
    response[offset++] = ldNameLen;
    ldNameBuf.copy(response, offset);
    offset += ldNameLen;

    // moreFollows [1] BOOLEAN
    response[offset++] = 0x81; // tag
    response[offset++] = 0x01; // length 1
    response[offset++] = logicalDevices.length > 1 ? 0xFF : 0x00; // TRUE if more LDs, else FALSE

    return response;
}

// Basic Template Response
function buildTemplateResponse() {
    return Buffer.from([
        0x03, 0x00, 0x00, 0x2D,  // TPKT: version 3, length 45
        0x02,                     // COTP: length 2
        0xF0,                     // COTP: DT (Data)
        0x80,                     // COTP: EOT flag
        // MMS Confirmed-ResponsePDU
        0xA1, 0x26,              // [1] IMPLICIT SEQUENCE (38 bytes)
        // invokeID (match request or use 0)
        0x02, 0x01, 0x00,        // INTEGER 0
        // getNameList Response [1]
        0xA1, 0x21,              // [1] IMPLICIT SEQUENCE (33 bytes)
        // listOfIdentifier [0]
        0xA0, 0x0A,              // [0] IMPLICIT SEQUENCE OF (10 bytes)
        // Identifier: "TEMPLATE"  
        0x1A, 0x08, 0x54, 0x45, 0x4D, 0x50, 0x4C, 0x41, 0x54, 0x45,
        // moreFollows [1] = FALSE
        0x81, 0x01, 0x00         // [1] BOOLEAN FALSE
    ]);
}

function buildErrorResponse() {
    return Buffer.from([
        0x03, 0x00, 0x00, 0x0F,  // TPKT: version 3, length 15
        0x02,                     // COTP: length 2
        0xF0,                     // COTP: DT (Data)
        0x80,                     // COTP: EOT flag
        // MMS Confirmed-ErrorPDU
        0xA2, 0x08,              // [2] IMPLICIT SEQUENCE (8 bytes)
        0x02, 0x01, 0x00,        // invokeID INTEGER 0
        0xA0, 0x03,              // [0] ServiceError
        0x80, 0x01, 0x01         // service-not-supported
    ]);
}

function buildInitiateResponse() {
    return Buffer.from([
        0x03, 0x00, 0x00, 0x46,  // TPKT: version 3, length 70 bytes
        0x02,                     // COTP: length 2
        0xF0,                     // COTP: DT (Data)
        0x80,                     // COTP: EOT flag
        // MMS Initiate-ResponsePDU
        0xA9, 0x3E,              // [UNIVERSAL 9] IMPLICIT SEQUENCE (62 bytes)
        // localDetailCalling (negotiated parameter)
        0x80, 0x01, 0x01,        // [0] INTEGER 1 (local detail)
        // negociatedMaxServOutstandingCalling
        0x81, 0x01, 0x01,        // [1] INTEGER 1
        // negociatedMaxServOutstandingCalled
        0x82, 0x01, 0x01,        // [2] INTEGER 1
        // negociatedDataStructureNestingLevel (optional removed for compatibility)
        // negociatedMaxPduSize
        0x88, 0x03, 0x00, 0xFF, 0xF0,  // [8] INTEGER 65520 (max PDU size)
        // proposedVersionNumber - IEC 61850 Ed 2
        0x89, 0x02, 0x07, 0xC0,  // [9] BIT STRING 0x07C0 = version 1+2 (Ed 1 & Ed 2)
        // proposedParameterCBB - STR1+STR2+NEST
        0x8A, 0x05, 0x04, 0xF1, 0x00, 0x00, 0x00,  // [10] BIT STRING (CBB = 0xF1000000)
        // servicesSupportedCalling (advertise GetNameList, Identify, Read, etc.)
        0x8B, 0x20,              // [11] BIT STRING (32 bytes of service flags)
        0x5F, 0x1F, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00,  // Status, GetNameList, Identify, Read
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x08,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);
}

function buildCotpConnectionConfirm() {
    return Buffer.from([
        0x03, 0x00, 0x00, 0x0B,  // TPKT: version 3, length 11
        0x06,                     // COTP: length 6
        0xD0,                     // COTP: CC (Connection Confirm)
        0x00, 0x00,               // COTP: dst-ref
        0x00, 0x01,               // COTP: src-ref
        0x00                      // COTP: class
    ]);
}

module.exports = {
    buildGetNameListResponse,
    buildTemplateResponse,
    buildErrorResponse,
    buildInitiateResponse,
    buildCotpConnectionConfirm
};
