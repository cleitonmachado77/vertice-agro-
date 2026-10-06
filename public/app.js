document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
});

document.querySelectorAll('[data-editable-row]').forEach((row) => {
  const updateForm = row.matches('form.production-edit-form') ? row : row.querySelector('form[data-row-update]');
  const editButton = row.querySelector('[data-edit-start]');
  const saveButton = row.querySelector('[data-edit-save]');
  const cancelButton = row.querySelector('[data-edit-cancel]');
  if (!updateForm || !editButton || !saveButton || !cancelButton) return;

  const controls = [...row.querySelectorAll('[form]')]
    .filter((control) => control.getAttribute('form') === updateForm.id && control !== saveButton);

  const setEditing = (editing) => {
    controls.forEach((control) => { control.disabled = !editing; });
    editButton.hidden = editing;
    saveButton.hidden = !editing;
    cancelButton.hidden = !editing;
    row.classList.toggle('is-editing', editing);
  };

  setEditing(false);
  editButton.addEventListener('click', () => {
    setEditing(true);
    controls.find((control) => control.matches('input:not([type="hidden"]), select, textarea'))?.focus();
  });
  cancelButton.addEventListener('click', () => {
    updateForm.reset();
    setEditing(false);
  });
});

document.querySelectorAll('form.production-form').forEach((form) => {
  const propertySelect = form.querySelector('select[name="propertyId"]');
  const activitySelect = form.querySelector('select[name="activityPropertyId"]');
  const productSelect = form.querySelector('select[name="productId"]');
  if (!activitySelect || !productSelect) return;
  const talhaoSelect = form.querySelector('select[name="talhaoId"]');
  const plannedAreaInput = form.querySelector('input[name="areaPlanned"]');
  const talhaoAreaHelp = form.querySelector('[data-talhao-area-help]');
  const unitDisplay = form.querySelector('[data-unit-display]');

  const filterOptions = () => {
    const propertyId = propertySelect?.value;
    const activityId = activitySelect.selectedOptions[0]?.dataset.activityId;
    [activitySelect, talhaoSelect, productSelect].forEach((select) => {
      if (!select) return;
      [...select.options].forEach((option) => {
        const wrongProperty = select !== productSelect && Boolean(option.value && (!propertyId || option.dataset.propertyId !== propertyId));
        const wrongActivity = select === productSelect && Boolean(option.value && (!activityId || option.dataset.activityId !== activityId));
        option.disabled = Boolean(option.value && (wrongProperty || wrongActivity));
        if (option.selected && option.disabled) select.value = '';
      });
    });
    updateProductUnit();
  };

  const updateProductUnit = () => {
    const option = productSelect.selectedOptions[0];
    if (unitDisplay) unitDisplay.value = option?.dataset.unitName ? `${option.dataset.unitName} (${option.dataset.unitSigla})` : '';
  };

  propertySelect?.addEventListener('change', filterOptions);
  activitySelect.addEventListener('change', filterOptions);
  productSelect.addEventListener('change', updateProductUnit);
  filterOptions();

  const fillTalhaoArea = (resetArea = false) => {
    const option = talhaoSelect?.selectedOptions[0];
    const area = option?.dataset.area;
    if (!plannedAreaInput) return;
    if (!area) {
      plannedAreaInput.value = '';
      plannedAreaInput.removeAttribute('max');
      if (talhaoAreaHelp) talhaoAreaHelp.textContent = 'Selecione um talhão para consultar a área disponível.';
      return;
    }
    if (resetArea || !plannedAreaInput.value) plannedAreaInput.value = area;
    plannedAreaInput.max = area;
    if (talhaoAreaHelp) talhaoAreaHelp.textContent = `Área total do Talhão: ${area}${option.dataset.areaUnit ? ` ${option.dataset.areaUnit}` : ''}`;
  };
  talhaoSelect?.addEventListener('change', () => fillTalhaoArea(true));
  propertySelect?.addEventListener('change', () => fillTalhaoArea(true));
  fillTalhaoArea();

  const situationSelect = form.querySelector('select[name="situation"]');
  const plannedFields = form.querySelector('[data-planned-fields]');
  const realizedField = form.querySelector('[data-realized-field]');
  const forecastFields = plannedFields?.querySelectorAll('input') || [];
  const realizedInput = realizedField?.querySelector('input');
  const updateModeFields = () => {
    const isRealized = situationSelect?.value === 'Realizada';
    if (plannedFields) plannedFields.hidden = isRealized;
    forecastFields.forEach((input) => { input.required = !isRealized; });
    if (realizedField) realizedField.hidden = !isRealized;
    if (realizedInput) realizedInput.required = isRealized;
  };
  situationSelect?.addEventListener('change', updateModeFields);
  updateModeFields();
});

document.querySelectorAll('form[data-animal-form]').forEach((form) => {
  const propertySelect = form.querySelector('select[name="propertyId"]');
  const activitySelect = form.querySelector('select[name="activityPropertyId"]');
  const sexSelect = form.querySelector('select[name="sex"]');
  const categorySelect = form.querySelector('select[name="categoryId"]');
  const firstCalvingInput = form.querySelector('input[name="firstCalving"]');
  const firstCalvingField = form.querySelector('[data-first-calving-field]');
  const belongsToHerd = form.querySelector('input[name="belongsToHerd"]');
  const exitFields = form.querySelector('[data-animal-exit-fields]');
  const exitControls = exitFields ? [...exitFields.querySelectorAll('input, select')] : [];
  if (!propertySelect || !activitySelect || !sexSelect || !categorySelect) return;

  const updateAnimalOptions = () => {
    const propertyId = propertySelect.value;
    [...activitySelect.options].forEach((option) => {
      option.disabled = Boolean(option.value && option.dataset.propertyId !== propertyId);
      if (option.selected && option.disabled) activitySelect.value = '';
    });
    const sex = sexSelect.value;
    [...categorySelect.options].forEach((option) => {
      option.disabled = Boolean(option.value && option.dataset.sex !== sex);
      if (option.selected && option.disabled) categorySelect.value = '';
    });
    if (firstCalvingInput) {
      firstCalvingInput.disabled = sex === 'M';
      if (firstCalvingField) firstCalvingField.hidden = sex === 'M';
      if (sex === 'M') firstCalvingInput.value = '';
    }
    const inHerd = belongsToHerd?.checked ?? true;
    exitControls.forEach((control) => {
      control.disabled = inHerd;
      if (inHerd) control.value = '';
    });
  };

  propertySelect.addEventListener('change', updateAnimalOptions);
  sexSelect.addEventListener('change', updateAnimalOptions);
  belongsToHerd?.addEventListener('change', updateAnimalOptions);
  updateAnimalOptions();
});

document.querySelectorAll('form.property-activity-form').forEach((form) => {
  const activitySelect = form.querySelector('select[name="activityId"]');
  const coverageField = form.querySelector('[data-coverage-field]');
  const coverageInput = coverageField?.querySelector('input[name="coverageAge"]');
  if (!activitySelect || !coverageField || !coverageInput) return;

  const updateCoverage = () => {
    const isLivestock = activitySelect.selectedOptions[0]?.dataset.livestock === '1';
    coverageField.hidden = !isLivestock;
    coverageInput.disabled = !isLivestock;
    if (!isLivestock) coverageInput.value = '';
  };
  activitySelect.addEventListener('change', updateCoverage);
  updateCoverage();
});

document.querySelectorAll('tr[data-activity-row]').forEach((row) => {
  const activitySelect = row.querySelector('select[name="activityId"]');
  const coverageCell = row.querySelector('[data-coverage-cell]');
  const coverageInput = coverageCell?.querySelector('input[name="coverageAge"]');
  if (!activitySelect || !coverageCell || !coverageInput) return;

  const updateCoverage = () => {
    const isLivestock = activitySelect.selectedOptions[0]?.dataset.livestock === '1';
    coverageCell.hidden = !isLivestock;
    coverageInput.disabled = !isLivestock;
    if (!isLivestock) coverageInput.value = '';
  };
  activitySelect.addEventListener('change', updateCoverage);
  updateCoverage();
});

document.querySelectorAll('form[data-pregnancy-confirm-form]').forEach((form) => {
  const confirmationDate = form.querySelector('input[name="confirmationDate"]');
  const pregnancyDate = form.querySelector('input[name="pregnancyDate"]');
  const daysPregnant = form.querySelector('input[name="daysPregnant"]');
  const expectedDate = form.querySelector('[data-expected-calving-date]');
  const gestationDays = Number(form.dataset.gestationDays);
  if (!confirmationDate || !pregnancyDate || !daysPregnant || !expectedDate || !Number.isInteger(gestationDays)) return;

  const updateExpectedDate = () => {
    const daysValue = daysPregnant.value.trim();
    const days = daysValue ? Number(daysValue) : null;
    if (daysValue && (!Number.isInteger(days) || days < 0 || days > gestationDays)) return;
    const referenceDate = days === null ? pregnancyDate.value : confirmationDate.value;
    if (!referenceDate) return;
    const dueDate = new Date(`${referenceDate}T00:00:00.000Z`);
    dueDate.setUTCDate(dueDate.getUTCDate() + (days === null ? gestationDays : gestationDays - days));
    expectedDate.value = dueDate.toISOString().slice(0, 10);
  };
  confirmationDate.addEventListener('change', updateExpectedDate);
  pregnancyDate.addEventListener('change', updateExpectedDate);
  daysPregnant.addEventListener('input', updateExpectedDate);
  updateExpectedDate();
});

document.querySelectorAll('form[data-calving-form]').forEach((form) => {
  const birthType = form.querySelector('[data-birth-type]');
  const rows = [...form.querySelectorAll('[data-offspring-row]')];
  if (!birthType || !rows.length) return;

  const updateOffspringFields = () => {
    const quantity = Number(birthType.selectedOptions[0]?.dataset.quantity || 0);
    rows.forEach((row, index) => {
      const enabled = index < quantity;
      row.hidden = !enabled;
      row.querySelectorAll('select, input').forEach((control) => {
        control.disabled = !enabled;
        if (control.matches('select')) control.required = enabled;
      });
    });
  };
  birthType.addEventListener('change', updateOffspringFields);
  updateOffspringFields();
});