const { contextBridge, ipcRenderer } = require("electron");

function getToken() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    return params.get("token") || "";
  } catch (error) {
    return "";
  }
}

function channel(name) {
  const token = getToken();
  if (!token) return "";
  return `high-risk-confirm:${name}:${token}`;
}

contextBridge.exposeInMainWorld("highRiskConfirm", {
  getPayload: () => {
    const payloadChannel = channel("get-payload");
    if (!payloadChannel) return Promise.resolve(null);
    return ipcRenderer.invoke(payloadChannel);
  },
  decide: (allowed) => {
    const decisionChannel = channel("decision");
    if (!decisionChannel) return;
    ipcRenderer.send(decisionChannel, allowed === true);
  },
});
