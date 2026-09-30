import { Fragment } from "react";
import { ScrollView } from "react-native";
import { useChatComposer } from "../../model/chat-composer-context";
import {
  ENGINE_PICKER_MODEL_IDS,
  modelDescription,
  modelLabel,
  selectedModelId,
} from "../../model/composer-selection";
import { ModelLogo } from "../model-logo";
import { SheetRow, SheetRowSeparator, SheetSection } from "./sheet-rows";
import { useCloseModelSheet } from "./use-close-model-sheet";

/** The models the selected coding agent can run. Choosing one finishes with the sheet. */
export function ModelSheetModels() {
  const { locks, selection, updateSelection } = useChatComposer();
  const close = useCloseModelSheet();
  if (selection.engine === "opencompany") return null;
  const engine = selection.engine;
  const currentModelId = selectedModelId(selection);
  const modelIds = [...ENGINE_PICKER_MODEL_IDS[engine]];
  if (!modelIds.includes(currentModelId)) modelIds.unshift(currentModelId);

  return (
    <ScrollView
      contentContainerClassName="px-4 pt-2 pb-10"
      contentInsetAdjustmentBehavior="automatic"
    >
      <SheetSection>
        {modelIds.map((modelId, index) => {
          const selected = modelId === currentModelId;
          return (
            <Fragment key={modelId}>
              {index > 0 ? <SheetRowSeparator /> : null}
              <SheetRow
                accessory="check"
                disabled={locks.engineAndModel && !selected}
                leading={<ModelLogo modelId={modelId} size={22} />}
                onPress={() => {
                  if (!selected)
                    updateSelection((current) =>
                      engine === "codex"
                        ? { ...current, codexModelId: modelId }
                        : { ...current, claudeModelId: modelId },
                    );
                  close();
                }}
                selected={selected}
                subtitle={modelDescription(modelId)}
                title={modelLabel(modelId)}
              />
            </Fragment>
          );
        })}
      </SheetSection>
    </ScrollView>
  );
}
