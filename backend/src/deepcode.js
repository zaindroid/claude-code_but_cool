// DeepCode's own configuration file, written for an account from its Codez settings.
//
// DeepCode will not start at all until `~/.deepcode/deepcode_config.json` exists. Its message for
// that state is twelve lines of debug logging and two paths, which is what a new DeepCode agent
// handed its user. The message tells you to run `deepcode init` -- and in this container that
// command fails, because init copies an existing config and the pip package ships no
// `deepcode_config.json.example` to copy from:
//
//   $ deepcode init
//   Error: No source config found: pass --from <path>, run from a directory that has a
//   deepcode_config.json, or restore deepcode_config.json.example.
//
// So the file is written here instead. The shape below is not a guess -- it was run against the
// real binary in this container before this file existed, and DeepCode answered:
//
//   core.llm_runtime:get_workflow_provider:65 - Resolved workflow LLM:
//   phase=implementation provider=openai model=openai/gpt-4o-mini
//
// The key is never in the file. DeepCode resolves `${ENV_VAR}` inside apiKey at run time
// (core/config.py), so the config holds a reference and the value comes from the environment
// (settings.js's deepcodeEnv), out of the same encrypted store as every other credential here.
import fs from 'node:fs';
import path from 'node:path';
import { chownToUser } from './osUsers.js';
import { readSettings, DEEPCODE_PROVIDERS } from './settings.js';

export const CONFIG_REL = '.deepcode/deepcode_config.json';

function configPath(user) {
  return path.join(user.homeDir, CONFIG_REL);
}

export function deepcodeConfigured(user) {
  return fs.existsSync(configPath(user));
}

// Rewritten from settings every time they are saved, rather than merged into whatever is there.
// A config this small has nothing worth preserving, and a merge would quietly keep a provider the
// account had already moved off -- which for a file that decides which API gets billed is the
// wrong kind of surprise. Anything hand-edited in here is replaced, and the settings page is the
// place to say so.
export function writeDeepcodeConfig(user) {
  const s = readSettings(user);
  const spec = DEEPCODE_PROVIDERS.find((p) => p.id === s.deepcodeProvider);
  if (!spec) return { written: false, reason: 'no provider chosen' };

  const provider = {};
  // A local provider has no key and must be told where it is listening; the hosted ones are the
  // other way round. Writing an empty apiKey for Ollama would make DeepCode look for a secret
  // that does not exist.
  if (spec.needsKey) provider.apiKey = '${DEEPCODE_API_KEY}';
  if (s.deepcodeBaseUrl) provider.apiBase = s.deepcodeBaseUrl;

  const defaults = { provider: spec.id };
  // Left out unless asked for: with no model named, DeepCode falls back to its own default for
  // each phase, which is a better answer than one model this app picked for every phase.
  if (s.deepcodeModel) defaults.model = s.deepcodeModel;

  const config = { providers: { [spec.id]: provider }, agents: { defaults } };
  const file = configPath(user);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  chownToUser(path.dirname(file), user.uid, user.gid);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  chownToUser(file, user.uid, user.gid);
  return { written: true, provider: spec.id };
}
