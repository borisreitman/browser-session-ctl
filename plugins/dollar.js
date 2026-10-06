// dollar.com helpers: dismiss the email opt-in modal and read location search results.
class Plugin {
  help() {
    return [
      'closePopup()        click the "Don\'t miss out!" email opt-in close button',
      'locations()         text of the Locations page search results panel ("No results found" if none)',
    ].join('\n');
  }

  closePopup() {
    const c = document.querySelector('.mkg-optin-modal-close');
    if (!c) return {clicked: false};
    c.click();
    return {clicked: true};
  }

  locations() {
    const box = document.querySelector('[role=combobox]');
    const panel = box && box.closest('div[class*=emotion]') && box.closest('div[class*=emotion]').parentElement;
    return {
      query: box ? box.value : null,
      results: panel ? panel.innerText.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 20) : [],
    };
  }
}
