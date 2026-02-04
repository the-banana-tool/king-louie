// DOM Elements
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const chatMessages = document.getElementById('chat-messages');
const newChatBtn = document.getElementById('new-chat-btn');
const chatList = document.getElementById('chat-list');

// Send message function
function sendMessage() {
  const message = userInput.value.trim();
  
  if (message === '') {
    return;
  }

  // Add user message to chat
  addMessage('user', message);

  // Clear input
  userInput.value = '';
  userInput.style.height = 'auto';

  // Simulate assistant response (in a real app, this would call an API)
  setTimeout(() => {
    addMessage('assistant', 'This is a simulated response. In a real application, this would be connected to your chat backend or AI service.');
  }, 500);
}

// Add message to chat display
function addMessage(sender, text) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${sender}`;
  
  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';
  
  const senderLabel = document.createElement('strong');
  senderLabel.textContent = sender === 'user' ? 'You:' : 'Assistant:';
  
  const messagePara = document.createElement('p');
  messagePara.textContent = text;
  
  messageContent.appendChild(senderLabel);
  messageContent.appendChild(messagePara);
  messageDiv.appendChild(messageContent);
  
  chatMessages.appendChild(messageDiv);
  
  // Scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Event Listeners
sendBtn.addEventListener('click', sendMessage);

userInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea as user types
userInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 200) + 'px';
});

// New chat button
newChatBtn.addEventListener('click', () => {
  // Clear current chat
  chatMessages.innerHTML = '';
  addMessage('assistant', 'New chat started! How can I help you today?');
  
  // Add new chat item to list (in a real app, this would save to database)
  const chatItem = document.createElement('div');
  chatItem.className = 'chat-item active';
  
  const titleDiv = document.createElement('div');
  titleDiv.className = 'chat-item-title';
  titleDiv.textContent = 'New Chat';
  
  const previewDiv = document.createElement('div');
  previewDiv.className = 'chat-item-preview';
  previewDiv.textContent = 'Just started...';
  
  chatItem.appendChild(titleDiv);
  chatItem.appendChild(previewDiv);
  
  // Remove active class from all items
  document.querySelectorAll('.chat-item').forEach(item => {
    item.classList.remove('active');
  });
  
  // Add new chat to top of list
  chatList.insertBefore(chatItem, chatList.firstChild);
});

// Chat history item click handler
chatList.addEventListener('click', (e) => {
  const chatItem = e.target.closest('.chat-item');
  if (chatItem) {
    // Remove active class from all items
    document.querySelectorAll('.chat-item').forEach(item => {
      item.classList.remove('active');
    });
    
    // Add active class to clicked item
    chatItem.classList.add('active');
    
    // In a real app, this would load the chat history from storage
    chatMessages.innerHTML = '';
    addMessage('assistant', 'Loading chat history... In a real application, this would load the selected conversation.');
  }
});
