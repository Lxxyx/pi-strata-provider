export function explainStrataError(message: string): string {
  if (/\b401\b|authentication_error|missing or wrong API key/i.test(message)) {
    return "Strata authentication failed. Run /login and choose Strata, or set STRATA_API_KEY to the server's real key. The default strata-local placeholder only works when authentication is disabled.";
  }
  if (/\b403\b|untrusted host|allowed_hosts|host.*not allowed/i.test(message)) {
    return "Strata refused this host. Check the server's allowed_hosts setting, connect using 127.0.0.1, or configure an API key. Browser CORS settings are not needed for Pi.";
  }
  if (/exceeds the context|leaves no room to answer/i.test(message)) {
    return "context_length_exceeded: Strata rejected prompt plus output budget. Pi can compact and retry; /strata setup applies matching local compaction presets. The server's optional fit_max_tokens setting is an additional safeguard.";
  }
  if (/\b503\b|engine is starting|engine is not running/i.test(message)) {
    return "Strata's engine is not ready. Wait for the model to finish loading, then retry. Run /strata refresh after switching models.";
  }
  if (/ECONNREFUSED|fetch failed|connect.*refused|ETIMEDOUT|timed out/i.test(message)) {
    return "Cannot reach Strata. Start the local server and check its URL and port in /strata. If it is already loading a model or processing a long prompt, wait and retry.";
  }
  return message;
}
