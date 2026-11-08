//! Node-API side of Apollo's desktop tailnet addon. Exposes the Go archive's single entry
//! point (ApolloTailnetCall) to JavaScript:
//!
//!   call(method, argsJson)     -> Promise<string>, run on the libuv thread pool
//!                                 (starting the node or talking to control can take seconds)
//!   callSync(method, argsJson) -> string, for quick lookups on the request path ("peer")

use std::ffi::{c_char, CStr, CString};

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Task};
use napi_derive::napi;

extern "C" {
    fn ApolloTailnetCall(method: *mut c_char, args: *mut c_char) -> *mut c_char;
    fn ApolloTailnetFree(result: *mut c_char);
}

/// Calls into Go; `None` when it returned nothing.
fn call_go(method: &str, args: &str) -> Result<Option<String>> {
    let method = CString::new(method).map_err(|_| Error::from_reason("method contains a NUL byte"))?;
    let args = CString::new(args).map_err(|_| Error::from_reason("argsJson contains a NUL byte"))?;
    // SAFETY: Go copies both strings before returning and hands back a C string it
    // allocated (or null), which we free with its own free function.
    unsafe {
        let result = ApolloTailnetCall(method.as_ptr() as *mut c_char, args.as_ptr() as *mut c_char);
        if result.is_null() {
            return Ok(None);
        }
        let text = CStr::from_ptr(result).to_string_lossy().into_owned();
        ApolloTailnetFree(result);
        Ok(Some(text))
    }
}

pub struct Call {
    method: String,
    args: String,
}

impl Task for Call {
    type Output = Option<String>;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        call_go(&self.method, &self.args)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        output.ok_or_else(|| Error::from_reason("apollo-tailnet: call cancelled"))
    }
}

#[napi]
pub fn call(method: String, args_json: String) -> AsyncTask<Call> {
    AsyncTask::new(Call { method, args: args_json })
}

#[napi(js_name = "callSync")]
pub fn call_sync(method: String, args_json: String) -> Result<String> {
    Ok(call_go(&method, &args_json)?.unwrap_or_else(|| "null".to_string()))
}
