use serde_json::{Map, Value};
use std::fmt;

pub const CALL_DEFERRED_TOOL_NAME: &str = "CallDeferredTool";

#[derive(Debug, Clone, PartialEq)]
pub struct CallDeferredToolInput {
    pub tool_name: String,
    pub args: Value,
}

impl CallDeferredToolInput {
    pub fn canonical_wire_arguments(&self) -> Value {
        let mut call = Map::new();
        call.insert(self.tool_name.clone(), self.args.clone());
        serde_json::json!({
            "call": Value::Object(call),
        })
    }

    /// Keep replay JSON in the same single-key envelope exposed to providers.
    pub fn canonical_wire_json(&self) -> serde_json::Result<String> {
        serde_json::to_string(&self.canonical_wire_arguments())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallDeferredToolInputError {
    InputMustBeObject,
    MissingToolName,
    EmptyToolName,
    MissingArgs,
    ArgsMustBeObject,
    CallMustBeObject,
    CallMustContainExactlyOneTool,
    UnexpectedField(String),
}

impl fmt::Display for CallDeferredToolInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputMustBeObject => {
                write!(formatter, "CallDeferredTool input must be an object")
            }
            Self::MissingToolName => write!(formatter, "tool_name is required"),
            Self::EmptyToolName => write!(formatter, "tool_name cannot be empty"),
            Self::MissingArgs => write!(formatter, "args is required"),
            Self::ArgsMustBeObject => write!(formatter, "args must be an object"),
            Self::CallMustBeObject => write!(formatter, "call must be an object"),
            Self::CallMustContainExactlyOneTool => {
                write!(formatter, "call must contain exactly one deferred tool")
            }
            Self::UnexpectedField(field) => {
                write!(formatter, "unexpected CallDeferredTool field: {field}")
            }
        }
    }
}

impl std::error::Error for CallDeferredToolInputError {}

pub fn call_deferred_tool_input_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["call"],
        "properties": {
            "call": {
                "type": "object",
                "minProperties": 1,
                "maxProperties": 1,
                "additionalProperties": {
                    "type": "object",
                    "additionalProperties": true
                },
                "description": "Exactly one property whose name is the deferred tool name and whose value contains that tool's arguments."
            }
        }
    })
}

pub fn call_deferred_tool_short_description() -> String {
    "Call a deferred tool whose full schema was loaded with GetToolSpec.".to_string()
}

pub fn call_deferred_tool_description() -> String {
    r#"Call a deferred tool after reading its full schema with GetToolSpec.

Pass exactly one property inside call. Its key is the exact deferred tool name and its value contains only that tool's arguments.
For example: {"call":{"CreatePlan":{"name":"Plan","overview":"...","plan":"..."}}}."#
        .to_string()
}

fn parse_tool_keyed_call_ref<'a>(
    object: &'a Map<String, Value>,
) -> Result<Option<(&'a str, &'a Value)>, CallDeferredToolInputError> {
    let Some(call) = object.get("call") else {
        return Ok(None);
    };

    if let Some(field) = object.keys().find(|field| field.as_str() != "call") {
        return Err(CallDeferredToolInputError::UnexpectedField(field.clone()));
    }

    let call = call
        .as_object()
        .ok_or(CallDeferredToolInputError::CallMustBeObject)?;
    let mut entries = call.iter();
    let Some((tool_name, args)) = entries.next() else {
        return Err(CallDeferredToolInputError::CallMustContainExactlyOneTool);
    };
    if entries.next().is_some() {
        return Err(CallDeferredToolInputError::CallMustContainExactlyOneTool);
    }
    if tool_name.trim().is_empty() {
        return Err(CallDeferredToolInputError::EmptyToolName);
    }
    if !args.is_object() {
        return Err(CallDeferredToolInputError::ArgsMustBeObject);
    }

    Ok(Some((tool_name, args)))
}

pub fn parse_call_deferred_tool_input(
    input: &Value,
) -> Result<CallDeferredToolInput, CallDeferredToolInputError> {
    let object = input
        .as_object()
        .ok_or(CallDeferredToolInputError::InputMustBeObject)?;

    if let Some((tool_name, args)) = parse_tool_keyed_call_ref(object)? {
        return Ok(CallDeferredToolInput {
            tool_name: tool_name.to_string(),
            args: args.clone(),
        });
    }

    // Read the previous envelope so historical calls can still be projected.
    let tool_name = object
        .get("tool_name")
        .and_then(Value::as_str)
        .ok_or(CallDeferredToolInputError::MissingToolName)?;
    if tool_name.trim().is_empty() {
        return Err(CallDeferredToolInputError::EmptyToolName);
    }

    let mut args = match object.get("args") {
        Some(Value::Object(args)) => args.clone(),
        Some(_) => return Err(CallDeferredToolInputError::ArgsMustBeObject),
        None => Map::new(),
    };

    for (field, value) in object {
        if field != "tool_name" && field != "args" && !args.contains_key(field) {
            args.insert(field.clone(), value.clone());
        }
    }

    Ok(CallDeferredToolInput {
        tool_name: tool_name.to_string(),
        args: Value::Object(args),
    })
}

fn parse_call_deferred_tool_input_ref(
    input: &Value,
) -> Result<(&str, &Value), CallDeferredToolInputError> {
    let object = input
        .as_object()
        .ok_or(CallDeferredToolInputError::InputMustBeObject)?;

    if let Some(parsed) = parse_tool_keyed_call_ref(object)? {
        return Ok(parsed);
    }

    // Read the previous envelope so historical calls can still be projected.
    if let Some(field) = object
        .keys()
        .find(|field| field.as_str() != "tool_name" && field.as_str() != "args")
    {
        return Err(CallDeferredToolInputError::UnexpectedField(field.clone()));
    }

    let tool_name = object
        .get("tool_name")
        .and_then(Value::as_str)
        .ok_or(CallDeferredToolInputError::MissingToolName)?;
    if tool_name.trim().is_empty() {
        return Err(CallDeferredToolInputError::EmptyToolName);
    }

    let args = object
        .get("args")
        .ok_or(CallDeferredToolInputError::MissingArgs)?;
    if !args.is_object() {
        return Err(CallDeferredToolInputError::ArgsMustBeObject);
    }

    Ok((tool_name, args))
}

/// Project a provider-facing invocation to the runtime tool identity without
/// allocating or duplicating persisted arguments. Invalid gateway payloads
/// fall back to their wire identity so historical data remains renderable.
pub fn effective_tool_invocation<'a>(
    wire_tool_name: &'a str,
    wire_arguments: &'a Value,
) -> (&'a str, &'a Value) {
    if wire_tool_name != CALL_DEFERRED_TOOL_NAME {
        return (wire_tool_name, wire_arguments);
    }

    parse_call_deferred_tool_input_ref(wire_arguments).unwrap_or((wire_tool_name, wire_arguments))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolInvocationKind {
    Direct,
    Deferred { gateway_tool_name: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedToolInvocation {
    pub wire_tool_name: String,
    pub wire_arguments: Value,
    pub effective_tool_name: String,
    pub effective_arguments: Value,
    pub kind: ToolInvocationKind,
}

impl ResolvedToolInvocation {
    pub fn direct(tool_name: impl Into<String>, arguments: Value) -> Self {
        let tool_name = tool_name.into();
        Self {
            wire_tool_name: tool_name.clone(),
            wire_arguments: arguments.clone(),
            effective_tool_name: tool_name,
            effective_arguments: arguments,
            kind: ToolInvocationKind::Direct,
        }
    }

    pub fn from_wire_call(
        tool_name: impl Into<String>,
        arguments: Value,
    ) -> Result<Self, CallDeferredToolInputError> {
        let tool_name = tool_name.into();
        if tool_name != CALL_DEFERRED_TOOL_NAME {
            return Ok(Self::direct(tool_name, arguments));
        }

        let parsed = parse_call_deferred_tool_input(&arguments)?;
        let wire_arguments = parsed.canonical_wire_arguments();
        Ok(Self {
            wire_tool_name: tool_name.clone(),
            wire_arguments,
            effective_tool_name: parsed.tool_name,
            effective_arguments: parsed.args,
            kind: ToolInvocationKind::Deferred {
                gateway_tool_name: tool_name,
            },
        })
    }

    pub fn is_deferred(&self) -> bool {
        matches!(self.kind, ToolInvocationKind::Deferred { .. })
    }

    pub fn replace_effective_arguments(&mut self, arguments: Value) {
        self.effective_arguments = arguments.clone();
        match self.kind {
            ToolInvocationKind::Direct => self.wire_arguments = arguments,
            ToolInvocationKind::Deferred { .. } => {
                self.wire_arguments = CallDeferredToolInput {
                    tool_name: self.effective_tool_name.clone(),
                    args: arguments,
                }
                .canonical_wire_arguments();
            }
        }
    }
}
