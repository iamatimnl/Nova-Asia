window.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    window.electronAPI.openWindow('pos.html');
    window.close();
  });
});