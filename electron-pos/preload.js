// notify.js

export function playNotification() {
  const audio = new Audio('assets/notification.wav');
  audio.play();
}
