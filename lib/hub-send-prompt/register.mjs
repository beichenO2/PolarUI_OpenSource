import { executeHubSendPrompt } from './executor.mjs';

let registered = false;

export function resetHubSendPromptRegistration() {
  registered = false;
}

/** @param {Function} registerExecutor */
export function registerHubSendPrompt(registerExecutor) {
  if (registered) return;
  registered = true;
  registerExecutor('HubSendPrompt', executeHubSendPrompt);
}

export default registerHubSendPrompt;
