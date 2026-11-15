import chalk from 'chalk';
import TextInput from '../../components/TextInput.js';
import { Box, Text } from '../../ink.js';
import { listModelEndpoints, readModelEndpoint, saveModelEndpoint, type ModelEndpoint } from '../../utils/model/modelEndpoints.js';
import { MODEL_ENDPOINT_HELP, parseEndpointCommand } from './endpointCommand.js';
import * as React from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { ModelPicker } from '../../components/ModelPicker.js';
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import type { EffortLevel } from '../../utils/effort.js';
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js';
import { clearFastModeCooldown, isFastModeAvailable, isFastModeEnabled, isFastModeSupportedByModel } from '../../utils/fastMode.js';
import { MODEL_ALIASES } from '../../utils/model/aliases.js';
import { checkOpus1mAccess, checkSonnet1mAccess } from '../../utils/model/check1mAccess.js';
import { getDefaultMainLoopModelSetting, isOpus1mMergeEnabled, renderDefaultModelSetting } from '../../utils/model/model.js';
import { isModelAllowed } from '../../utils/model/modelAllowlist.js';
import { validateModel } from '../../utils/model/validateModel.js';
function ModelPickerWrapper({ onDone }) {
  const mainLoopModel = useAppState(s => s.mainLoopModel);
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession);
  const isFastMode = useAppState(s => s.fastMode);
  const setAppState = useSetAppState();
  const pending = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => pending.current?.abort(), []);
  function handleCancel() {
    pending.current?.abort();
    logEvent('tengu_model_command_menu', { action: 'cancel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS });
    onDone(`Kept model as ${chalk.bold(renderModelLabel(mainLoopModel))}`, { display: 'system' });
  }
  async function handleSelect(model, effort) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    try {
      if (model && !isModelAllowed(model)) {
        onDone('Model is not available. Your organization restricts model selection.', { display: 'system' });
        return;
      }
      if (model && readModelEndpoint(model)) {
        const result = await validateModel(model, controller.signal);
        if (controller.signal.aborted) return;
        if (!result.valid) { onDone(result.error, { display: 'system' }); return; }
      }
      logEvent('tengu_model_command_menu', {
        action: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        from_model: mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        to_model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      setAppState(prev => ({ ...prev, mainLoopModel: model, mainLoopModelForSession: null }));
      let message = `Set model to ${chalk.bold(renderModelLabel(model))}`;
      if (effort !== undefined) message += ` with ${chalk.bold(effort)} effort`;
      let wasFastModeToggledOn;
      if (isFastModeEnabled()) {
        clearFastModeCooldown();
        if (!isFastModeSupportedByModel(model) && isFastMode) {
          setAppState(prev => ({ ...prev, fastMode: false }));
          wasFastModeToggledOn = false;
        } else if (isFastModeSupportedByModel(model) && isFastModeAvailable() && isFastMode) {
          message += ' · Fast mode ON';
          wasFastModeToggledOn = true;
        }
      }
      if (isBilledAsExtraUsage(model, wasFastModeToggledOn === true, isOpus1mMergeEnabled())) message += ' · Billed as extra usage';
      if (wasFastModeToggledOn === false) message += ' · Fast mode OFF';
      onDone(message);
    } catch {
      if (!controller.signal.aborted) onDone('Could not load or validate saved model endpoint. The current model was kept.', { display: 'system' });
    }
  }
  return <ModelPicker initial={mainLoopModel} sessionModel={mainLoopModelForSession} onSelect={handleSelect} onCancel={handleCancel} isStandaloneCommand={true} showFastModeNotice={isFastModeEnabled() && isFastMode && isFastModeSupportedByModel(mainLoopModel) && isFastModeAvailable()} />;
}

function SaveEndpoint({ input, onDone }: { input: Omit<ModelEndpoint, 'apiKey'>; onDone: (result: string, options?: { display: CommandResultDisplay }) => void }) {
  const [key, setKey] = React.useState('');
  const [cursor, setCursor] = React.useState(0);
  const [error, setError] = React.useState('');
  return <Box flexDirection="column">
    <Text>API key for {input.model} (masked; saved locally)</Text>
    <TextInput value={key} onChange={setKey} cursorOffset={cursor} onChangeCursorOffset={setCursor} mask="*" onSubmit={value => {
      try {
        saveModelEndpoint({ ...input, apiKey: value });
        setKey('');
        onDone(`Saved endpoint for ${input.model}. No network check was made. Run /model ${input.model} to validate and select it.`, { display: 'system' });
      } catch { setError('Could not save endpoint. Check the key and configuration directory permissions.'); }
    }} onExit={() => onDone('Model endpoint setup cancelled.', { display: 'system' })} />
    {error && <Text>{error}</Text>}
  </Box>;
}
function SetModelAndClose({
  args,
  onDone
}: {
  args: string;
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
}): React.ReactNode {
  const isFastMode = useAppState(s => s.fastMode);
  const setAppState = useSetAppState();
  const model = args === 'default' ? null : args;
  React.useEffect(() => {
    const controller = new AbortController();
    async function handleModelChange(): Promise<void> {
      if (model && !isModelAllowed(model)) {
        onDone(`Model '${model}' is not available. Your organization restricts model selection.`, {
          display: 'system'
        });
        return;
      }

      // @[MODEL LAUNCH]: Update check for 1M access.
      if (model && isOpus1mUnavailable(model)) {
        onDone(`Opus 4.6 with 1M context is not available for your account. Learn more: https://code.future.com/docs/en/model-config#extended-context-with-1m`, {
          display: 'system'
        });
        return;
      }
      if (model && isSonnet1mUnavailable(model)) {
        onDone(`Sonnet 4.6 with 1M context is not available for your account. Learn more: https://code.future.com/docs/en/model-config#extended-context-with-1m`, {
          display: 'system'
        });
        return;
      }

      // Skip validation for default model
      if (!model) {
        setModel(null);
        return;
      }

      // Skip validation for known aliases - they're predefined and should work
      if (isKnownAlias(model)) {
        setModel(model);
        return;
      }

      // Validate and set custom model
      try {
        // Don't use parseUserSpecifiedModel for non-aliases since it lowercases the input
        // and model names are case-sensitive
        const {
          valid,
          error: error_0
        } = await validateModel(model, controller.signal);
        if (controller.signal.aborted) return;
        if (valid) {
          setModel(model);
        } else {
          onDone(error_0 || `Model '${model}' not found`, {
            display: 'system'
          });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        onDone(`Failed to validate model: ${(error as Error).message}`, {
          display: 'system'
        });
      }
    }
    function setModel(modelValue: string | null): void {
      setAppState(prev => ({
        ...prev,
        mainLoopModel: modelValue,
        mainLoopModelForSession: null
      }));
      let message = `Set model to ${chalk.bold(renderModelLabel(modelValue))}`;
      let wasFastModeToggledOn = undefined;
      if (isFastModeEnabled()) {
        clearFastModeCooldown();
        if (!isFastModeSupportedByModel(modelValue) && isFastMode) {
          setAppState(prev_0 => ({
            ...prev_0,
            fastMode: false
          }));
          wasFastModeToggledOn = false;
          // Do not update fast mode in settings since this is an automatic downgrade
        } else if (isFastModeSupportedByModel(modelValue) && isFastMode) {
          message += ` · Fast mode ON`;
          wasFastModeToggledOn = true;
        }
      }
      if (isBilledAsExtraUsage(modelValue, wasFastModeToggledOn === true, isOpus1mMergeEnabled())) {
        message += ` · Billed as extra usage`;
      }
      if (wasFastModeToggledOn === false) {
        // Fast mode was toggled off, show suffix after extra usage billing
        message += ` · Fast mode OFF`;
      }
      onDone(message);
    }
    void handleModelChange();
    return () => controller.abort();
  }, [model, onDone, setAppState]);
  return null;
}
function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(model.toLowerCase().trim());
}
function isOpus1mUnavailable(model: string): boolean {
  const m = model.toLowerCase();
  return !checkOpus1mAccess() && !isOpus1mMergeEnabled() && m.includes('opus') && m.includes('[1m]');
}
function isSonnet1mUnavailable(model: string): boolean {
  const m = model.toLowerCase();
  // Warn about Sonnet and Sonnet 4.6, but not Sonnet 4.5 since that had
  // a different access criteria.
  return !checkSonnet1mAccess() && (m.includes('sonnet[1m]') || m.includes('sonnet-4-6[1m]'));
}
function ShowModelAndClose(t0) {
  const {
    onDone
  } = t0;
  const mainLoopModel = useAppState(_temp7);
  const mainLoopModelForSession = useAppState(_temp8);
  const effortValue = useAppState(_temp9);
  const displayModel = renderModelLabel(mainLoopModel);
  const effortInfo = effortValue !== undefined ? ` (effort: ${effortValue})` : "";
  if (mainLoopModelForSession) {
    onDone(`Current model: ${chalk.bold(renderModelLabel(mainLoopModelForSession))} (session override from plan mode)\nBase model: ${displayModel}${effortInfo}`);
  } else {
    onDone(`Current model: ${displayModel}${effortInfo}`);
  }
  return null;
}
function _temp9(s_1) {
  return s_1.effortValue;
}
function _temp8(s_0) {
  return s_0.mainLoopModelForSession;
}
function _temp7(s) {
  return s.mainLoopModel;
}
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || '';
  // Handle endpoint setup before analytics or inference: credentials never enter
  // logEvent, and this local command never needs the currently configured API.
  if (args === 'list' || /^add(?:\s|$)/.test(args)) {
    try {
      if (args === 'list') {
        const endpoints = listModelEndpoints().filter(p => isModelAllowed(p.model));
        onDone(endpoints.length ? endpoints.map(p => `${p.model} (${p.protocol})`).join('\n') : 'No saved model endpoints. Run /model add --help for usage.', { display: 'system' });
        return;
      }
      const input = parseEndpointCommand(args);
      if (!isModelAllowed(input.model)) {
        onDone('Model is not available. Your organization restricts model selection.', { display: 'system' });
        return;
      }
      if (input.apiKey !== undefined) {
        saveModelEndpoint({ ...input, apiKey: input.apiKey });
        onDone(`Saved endpoint for ${input.model}. No network check was made. Run /model ${input.model} to validate and select it.`, { display: 'system' });
        return;
      }
      return <SaveEndpoint input={input} onDone={onDone} />;
    } catch (error) {
      onDone((error as Error).message, { display: 'system' });
      return;
    }
  }
  if (COMMON_INFO_ARGS.includes(args)) {
    logEvent('tengu_model_command_inline_help', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    return <ShowModelAndClose onDone={onDone} />;
  }
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone(MODEL_ENDPOINT_HELP, {
      display: 'system'
    });
    return;
  }
  if (args) {
    logEvent('tengu_model_command_inline', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    return <SetModelAndClose args={args} onDone={onDone} />;
  }
  return <ModelPickerWrapper onDone={onDone} />;
};
function renderModelLabel(model: string | null): string {
  const rendered = renderDefaultModelSetting(model ?? getDefaultMainLoopModelSetting());
  return model === null ? `${rendered} (default)` : rendered;
}
