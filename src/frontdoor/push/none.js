// The default PushSender: sends nothing. Without push, phones see requests
// only while the app is open (it long-polls), and unseen requests expire
// closed (open question Q-A, program §8).
const noneSender = {
  id: 'none',
  platforms: [],
  async notify() {
    return { ok: true, dropToken: false };
  }
};

module.exports = { noneSender };
