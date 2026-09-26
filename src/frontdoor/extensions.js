// Relay extensions (program §4.13 "Mailbox", §5): one line per consumer stage.
// Each entry is (relay) => void and receives
//   { phoneApi, nodeHub, mailbox, pusher, devices, approvals, log }
// to register phone API routes (phoneApi.registerRoute), node methods
// (nodeHub.onNodeMessage) and mailbox types (mailbox.registerType). An
// extension must not require agent code: the relay loads no core, providers
// or tools. F5 adds its lease routes here, C4 its question routes.
module.exports = [];

// Cases stage 4 (R44): the phone app's Questions screen.
module.exports.push(require('./question-routes').registerQuestionRoutes);
