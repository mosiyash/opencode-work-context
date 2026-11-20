const modelRef = (session) => session?.model || (session?.modelID || session?.providerID ? session : null);

export const sessionModelLabel = (api, sessionId) => {
  if (!sessionId) return null;
  const session = api?.data?.session?.get?.(sessionId);
  const ref = modelRef(session);
  const modelID = ref?.id || ref?.modelID;
  if (!modelID) return null;
  const providerID = ref.providerID;
  const models = api?.data?.location?.model?.list?.(session?.location) || [];
  const model = models.find((item) => (!providerID || item.providerID === providerID)
    && (item.id === modelID || item.modelID === modelID));
  return model?.name || [providerID, modelID].filter(Boolean).join("/");
};

const capitalize = (value) => value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;

export const capabilitySummaryText = (stage, sessionModel) => {
  if (!stage?.execution_profile || !stage.execution_depth) return null;
  const model = stage.recommended_model ? capitalize(stage.recommended_model) : sessionModel;
  return [capitalize(stage.execution_profile), capitalize(stage.execution_depth), model].filter(Boolean).join(" · ");
};
