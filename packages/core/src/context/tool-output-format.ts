const UUID_SHAPE =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"

/** Exact opaque id emitted by Nexus for one persisted tool-result artifact. */
export const TOOL_OUTPUT_ARTIFACT_ID_PATTERN = new RegExp(
  `^artifact_${UUID_SHAPE}$`,
  "i",
)

/** Exact file basename corresponding to a Nexus tool-result artifact id. */
export const TOOL_OUTPUT_ARTIFACT_FILE_PATTERN = new RegExp(
  `^artifact_${UUID_SHAPE}\\.out$`,
  "i",
)

/** Hashed on-disk owner directory; raw session ids never become path segments. */
export const TOOL_OUTPUT_SESSION_DIRECTORY_PATTERN =
  /^session_[0-9a-f]{32}$/i
