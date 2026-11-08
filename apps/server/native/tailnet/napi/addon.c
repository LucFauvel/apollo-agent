// Node-API side of Apollo's desktop tailnet addon. Exposes the Go archive's single entry
// point (ApolloTailnetCall) to JavaScript:
//
//   call(method, argsJson)     -> Promise<string>, run on the libuv thread pool
//                                 (starting the node or talking to control can take seconds)
//   callSync(method, argsJson) -> string, for quick lookups on the request path ("peer")
#define NAPI_VERSION 8
#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include "libapollotailnet.h"

#define CHECK(call)                                                   \
  do {                                                                \
    if ((call) != napi_ok) {                                          \
      napi_throw_error(env, NULL, "apollo-tailnet: N-API call failed"); \
      return NULL;                                                    \
    }                                                                 \
  } while (0)

static char* string_arg(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) return NULL;
  char* buffer = malloc(length + 1);
  if (!buffer) return NULL;
  napi_get_value_string_utf8(env, value, buffer, length + 1, &length);
  return buffer;
}

static int two_strings(napi_env env, napi_callback_info info, char** method, char** args) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) return 0;
  *method = string_arg(env, argv[0]);
  *args = string_arg(env, argv[1]);
  if (!*method || !*args) {
    free(*method);
    free(*args);
    return 0;
  }
  return 1;
}

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  char* method;
  char* args;
  char* result;
} Job;

static void job_execute(napi_env env, void* data) {
  Job* job = data;
  job->result = ApolloTailnetCall(job->method, job->args);
}

static void job_complete(napi_env env, napi_status status, void* data) {
  Job* job = data;
  napi_value value;
  if (status == napi_ok && job->result) {
    napi_create_string_utf8(env, job->result, NAPI_AUTO_LENGTH, &value);
    napi_resolve_deferred(env, job->deferred, value);
  } else {
    napi_value message;
    napi_create_string_utf8(env, "apollo-tailnet: call cancelled", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &value);
    napi_reject_deferred(env, job->deferred, value);
  }
  if (job->result) ApolloTailnetFree(job->result);
  napi_delete_async_work(env, job->work);
  free(job->method);
  free(job->args);
  free(job);
}

static napi_value call(napi_env env, napi_callback_info info) {
  Job* job = calloc(1, sizeof(Job));
  if (!job || !two_strings(env, info, &job->method, &job->args)) {
    free(job);
    napi_throw_type_error(env, NULL, "call(method: string, argsJson: string)");
    return NULL;
  }
  napi_value promise, name;
  CHECK(napi_create_promise(env, &job->deferred, &promise));
  CHECK(napi_create_string_utf8(env, "apollo-tailnet", NAPI_AUTO_LENGTH, &name));
  CHECK(napi_create_async_work(env, NULL, name, job_execute, job_complete, job, &job->work));
  CHECK(napi_queue_async_work(env, job->work));
  return promise;
}

static napi_value call_sync(napi_env env, napi_callback_info info) {
  char *method = NULL, *args = NULL;
  if (!two_strings(env, info, &method, &args)) {
    napi_throw_type_error(env, NULL, "callSync(method: string, argsJson: string)");
    return NULL;
  }
  char* result = ApolloTailnetCall(method, args);
  free(method);
  free(args);
  napi_value value;
  napi_status status = napi_create_string_utf8(env, result ? result : "null", NAPI_AUTO_LENGTH, &value);
  if (result) ApolloTailnetFree(result);
  if (status != napi_ok) return NULL;
  return value;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"call", NULL, call, NULL, NULL, NULL, napi_default, NULL},
      {"callSync", NULL, call_sync, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, 2, props) != napi_ok) return NULL;
  return exports;
}
