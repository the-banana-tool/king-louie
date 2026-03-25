function shouldRespond({
  isGroup,
  requireMention,
  wasMentioned,
  isCommand,
  isReply
} = {}) {
  if (!isGroup) return true;
  if (isCommand) return true;
  if (isReply) return true;
  if (requireMention && !wasMentioned) return false;
  return true;
}

module.exports = {
  shouldRespond
};
