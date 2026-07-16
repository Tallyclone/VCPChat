"use strict";
(function (global) {
  function create(event, submit) {
    const card = document.createElement("form");
    card.className = "question-card";
    card.dataset.requestId = event.requestId;
    const questions = Array.isArray(event.questions) ? event.questions : [];
    questions.forEach((question, qi) => {
      const field = document.createElement("fieldset");
      field.innerHTML = `<legend>${question.question || question.header || "需要确认"}</legend>`;
      (question.options || []).forEach((option, oi) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = question.multiSelect ? "checkbox" : "radio";
        input.name = `q-${qi}`;
        input.value = option.label || "";
        label.append(input, document.createTextNode(` ${option.label || "选项"}${option.description ? ` — ${option.description}` : ""}`));
        field.append(label);
      });
      const other = document.createElement("input");
      other.type = "text"; other.name = `other-${qi}`; other.placeholder = "其他（可选）";
      field.append(other);
      card.append(field);
    });
    const button = document.createElement("button"); button.type = "submit"; button.textContent = "提交答案"; card.append(button);
    card.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (card.dataset.submitted === "true") return;
      const answers = {};
      questions.forEach((question, qi) => {
        const other = card.elements[`other-${qi}`]?.value?.trim();
        const checked = [...card.querySelectorAll(`[name="q-${qi}"]:checked`)].map((input) => input.value);
        answers[question.header || `question-${qi}`] = other || (question.multiSelect ? checked : (checked[0] || ""));
      });
      card.dataset.submitted = "true"; button.disabled = true; button.textContent = "提交中…";
      try { await submit(event.requestId, { answers }); button.textContent = "已提交"; }
      catch (error) { card.dataset.submitted = "false"; button.disabled = false; button.textContent = "重试提交"; }
    });
    return card;
  }
  global.E3QuestionCard = { create };
})(window);
