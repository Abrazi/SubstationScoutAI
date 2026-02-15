#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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

    IedServer_start(iedServer, tcpPort);

    if (!IedServer_isRunning(iedServer)) {
        fprintf(stderr, "Failed to start IEC 61850 server on port %d\n", tcpPort);
        IedServer_destroy(iedServer);
        return 2;
    }

    printf("IEC 61850 server started on port %d\n", tcpPort);

    while (running) {
        Thread_sleep(1000);
    }

    IedServer_stop(iedServer);
    IedServer_destroy(iedServer);

    if (gBindings)
        free(gBindings);

    return 0;
}