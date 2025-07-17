function playNotification() {
  const audio = new Audio('assets/notification.wav'); // ✅ 保留这样写
  audio.play();
}

module.exports = {
  playNotification
};
