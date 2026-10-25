/* Rouge Autofill — page hook (runs in the page's own world)
 * Upload widgets often make a file input that is never put on the page and call .click() on it.
 * Its change event never reaches content.js, so watch those inputs here and pass the chosen file on.
 */
(() => {
  'use strict';
  const watched = new WeakSet();
  const click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function rougeClick(...args) {
    if (this.type === 'file' && !watched.has(this)) {
      watched.add(this);
      this.addEventListener('change', () => {
        for (const file of this.files || []) window.postMessage({ __rouge: 'file', file }, '*');
      }, true);
    }
    return click.apply(this, args);
  };
})();
