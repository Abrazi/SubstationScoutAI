#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include "iec61850_server.h"
#include "hal_thread.h"
#include "ied_model.h"

static int running = 1;
static IedServer gIedServer = NULL;

typedef struct {
    DataObject* controlDo;
    DataAttribute* stValAttr;
    DataAttribute* tAttr;
    char reference[256];
} ControlBinding;

static ControlBinding* gBindings = NULL;
static int gBindingCount = 0;

static CheckHandlerResult
perform_check_handler(ControlAction action, void* parameter, MmsValue* ctlVal, bool test, bool interlockCheck)
{
    (void) action;
    (void) parameter;
    (void) ctlVal;
    (void) test;
    (void) interlockCheck;
    return CONTROL_ACCEPTED;
}

static ControlHandlerResult
generic_control_handler(ControlAction action, void* parameter, MmsValue* ctlVal, bool test)
{
    ControlBinding* binding = (ControlBinding*) parameter;

    if (binding == NULL)
        return CONTROL_RESULT_FAILED;

    if (test)
        return CONTROL_RESULT_OK;

    if (ControlAction_isSelect(action))
        return CONTROL_RESULT_OK;

    if (binding->stValAttr)
        IedServer_updateAttributeValue(gIedServer, binding->stValAttr, ctlVal);

    if (binding->tAttr)
        IedServer_updateUTCTimeAttributeValue(gIedServer, binding->tAttr, Hal_getTimeInMs());

    printf("CONTROL_UPDATE %s\n", binding->reference);
    fflush(stdout);

    return CONTROL_RESULT_OK;
}

static void
register_control_binding(ModelNode* node)
{
    ModelNode* oper = ModelNode_getChildWithFc(node, "Oper", IEC61850_FC_CO);
    ModelNode* stVal = ModelNode_getChildWithFc(node, "stVal", IEC61850_FC_ST);
    ModelNode* t = ModelNode_getChildWithFc(node, "t", IEC61850_FC_ST);

    if (oper == NULL)
        oper = ModelNode_getChild(node, "Oper");

    if (stVal == NULL)
        stVal = ModelNode_getChild(node, "stVal");

    if (t == NULL)
        t = ModelNode_getChild(node, "t");

    if ((oper == NULL) || (stVal == NULL))
        return;

    gBindings = (ControlBinding*) realloc(gBindings, sizeof(ControlBinding) * (gBindingCount + 1));

    if (gBindings == NULL) {
        gBindingCount = 0;
        return;
    }

    ControlBinding* binding = &gBindings[gBindingCount++];
    binding->controlDo = (DataObject*) node;
    binding->stValAttr = (DataAttribute*) stVal;
    binding->tAttr = (DataAttribute*) t;

    char* ref = ModelNode_getObjectReference(node, NULL);
    if (ref) {
        strncpy(binding->reference, ref, sizeof(binding->reference) - 1);
        binding->reference[sizeof(binding->reference) - 1] = '\0';
        free(ref);
    }
    else {
        strncpy(binding->reference, ModelNode_getName(node), sizeof(binding->reference) - 1);
        binding->reference[sizeof(binding->reference) - 1] = '\0';
    }

    IedServer_setPerformCheckHandler(gIedServer, binding->controlDo, perform_check_handler, binding);
    IedServer_setControlHandler(gIedServer, binding->controlDo, generic_control_handler, binding);

    printf("Registered control handler for %s\n", binding->reference);
}

static void
traverse_and_register(ModelNode* node)
{
    if (node == NULL)
        return;

    if (ModelNode_getType(node) == DataObjectModelType)
        register_control_binding(node);

    ModelNode* child = node->firstChild;
    while (child) {
        traverse_and_register(child);
        child = child->sibling;
    }
}

static void
register_all_control_handlers(IedModel* model)
{
    int ldCount = IedModel_getLogicalDeviceCount(model);

    for (int i = 0; i < ldCount; i++) {
        ModelNode* ld = (ModelNode*) IedModel_getDeviceByIndex(model, i);
        traverse_and_register(ld);
    }

    printf("Registered %d controllable data object handlers\n", gBindingCount);
}

// --- Bridge Logic ---

static void
handle_bridge_update(const char* ref, const char* valStr)
{
    if (!gIedServer) return;

    DataAttribute* attr = (DataAttribute*) IedModel_getModelNodeByObjectReference(&iedModel, ref);
    if (!attr) {
        // Try appending .stVal if not present, common abbreviation
        char buf[256];
        snprintf(buf, sizeof(buf), "%s.stVal", ref);
        attr = (DataAttribute*) IedModel_getModelNodeByObjectReference(&iedModel, buf);
    }

    if (!attr || ModelNode_getType((ModelNode*)attr) != DataAttributeModelType) {
        if (running) {
            printf("BRIDGE_ERR: Node not found or not attribute: %s\n", ref);
            fflush(stdout);
        }
        return;
    }

    MmsValue* newVal = NULL;
    // Type type = ModelNode_getType((ModelNode*)attr);
    // basic Type (MmsType) check requires accessing mmsValue type
    // We infer from MmsValue of the attribute if possible, or just try Types
    
    // For simplicity, we assume common types:
    // BOOLEAN, INT32, FLOAT32
    // We can check the node type directly if needed, but libiec61850 abstraction 
    // usually requires getting the specific BasicType from the MmsValue container or DataAttribute spec via 
    // DataAttribute_getType((DataAttribute*) node) -> but that returns complex MmsType enum
    
    // Let's rely on string parsing heuristics or check current value type
    // MmsValue* current = IedServer_getAttributeValue(gIedServer, attr); // Not public API easily
    // We will try to parse based on input format
    
    if (strcasecmp(valStr, "true") == 0 || strcasecmp(valStr, "false") == 0) {
        newVal = MmsValue_newBoolean(strcasecmp(valStr, "true") == 0);
    }
    else if (strchr(valStr, '.')) {
        newVal = MmsValue_newFloat(strtof(valStr, NULL));
    }
    else {
        newVal = MmsValue_newIntegerFromInt32(atoi(valStr));
    }

    if (newVal) {
        IedServer_updateAttributeValue(gIedServer, attr, newVal);
        
        // Also update timestamp 't' if it exists in the same DO
        ModelNode* parent = ModelNode_getParent((ModelNode*)attr);
        if (parent) {
            ModelNode* tNode = ModelNode_getChild(parent, "t");
            if (tNode) {
                IedServer_updateUTCTimeAttributeValue(gIedServer, (DataAttribute*)tNode, Hal_getTimeInMs());
            }
        }
        
        MmsValue_delete(newVal);
        if (running) {
            printf("BRIDGE_OK: Updated %s = %s\n", ref, valStr);
            fflush(stdout);
        }
    }
}

static void*
stdin_reader_thread(void* arg)
{
    (void) arg;
    char line[1024];
    while (running && fgets(line, sizeof(line), stdin)) {
        // Trim newline
        line[strcspn(line, "\r\n")] = 0;
        
        if (strlen(line) == 0) continue;

        // Message format: "REF=VALUE"
        char* eq = strchr(line, '=');
        if (eq) {
            *eq = 0;
            const char* ref = line;
            const char* val = eq + 1;
            handle_bridge_update(ref, val);
        }
    }
    return NULL;
}

// --------------------

static void
sigint_handler(int signalId)
{
    (void) signalId;
    running = 0;
}

int
main(int argc, char** argv)
{
    int tcpPort = 8102;

    setvbuf(stdout, NULL, _IOLBF, 0);
    setvbuf(stderr, NULL, _IOLBF, 0);

    if (argc > 1)
        tcpPort = atoi(argv[1]);

    signal(SIGINT, sigint_handler);

    IedServer iedServer = IedServer_create(&iedModel);
    gIedServer = iedServer;

    if (iedServer == NULL) {
        fprintf(stderr, "Failed to create IEC 61850 server\n");
        return 1;
    }

    register_all_control_handlers(&iedModel);

    // Start STDIN Interface Thread
    Thread thread = Thread_create(stdin_reader_thread, NULL, false);
    Thread_start(thread);

    IedServer_start(iedServer, tcpPort);

    if (!IedServer_isRunning(iedServer)) {
        fprintf(stderr, "Failed to start IEC 61850 server on port %d\n", tcpPort);
        IedServer_destroy(iedServer);
        return 2;
    }

    printf("IEC 61850 server started on port %d\n", tcpPort);
    fflush(stdout);

    while (running) {
        Thread_sleep(100);
    }

    IedServer_stop(iedServer);
    IedServer_destroy(iedServer);
    Thread_destroy(thread);

    if (gBindings)
        free(gBindings);

    return 0;
}