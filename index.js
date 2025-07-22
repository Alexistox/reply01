const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const readline = require('readline');

const config = require('./config');
const Utils = require('./utils');

class BankTransactionUserbot {
  constructor() {
    this.client = null;
    this.settings = Utils.loadSettings();
    this.isRunning = false;
    this.processedMessages = new Map(); // Store timestamp with message
    this.processingMessages = new Set(); // Track currently processing messages
    this.eventHandlerRegistered = false; // Prevent duplicate event handlers
    
    Utils.log('🤖 Bank Transaction Userbot khởi tạo');
    Utils.log(`📊 Trạng thái reply: ${this.settings.replyEnabled ? 'BẬT' : 'TẮT'}`);
  }

  // Khởi tạo client Telegram
  async initializeClient() {
    try {
      // Kiểm tra API credentials
      if (config.apiId === 'YOUR_API_ID' || config.apiHash === 'YOUR_API_HASH') {
        throw new Error('Vui lòng cập nhật API credentials trong config.js');
      }

      // Kiểm tra số điện thoại
      if (config.phoneNumber === 'YOUR_PHONE_NUMBER') {
        throw new Error('Vui lòng cập nhật số điện thoại trong config.js');
      }

      const stringSession = new StringSession(config.sessionString);
      
      this.client = new TelegramClient(stringSession, parseInt(config.apiId), config.apiHash, {
        connectionRetries: 5,
      });

      Utils.log('🔗 Đang kết nối tới Telegram...');
      
      // Check if session exists
      const hasValidSession = config.sessionString && config.sessionString.length > 10;
      if (hasValidSession) {
        Utils.log('🔑 Sử dụng session có sẵn - không cần OTP/2FA');
      } else {
        Utils.log('🆕 Lần đăng nhập đầu tiên - cần nhập mã xác nhận');
      }
      
      await this.client.start({
        phoneNumber: async () => {
          // Sử dụng số từ config, hoặc hỏi nếu không có
          if (config.phoneNumber && config.phoneNumber !== 'YOUR_PHONE_NUMBER') {
            Utils.log(`📱 Sử dụng số điện thoại từ config: ${config.phoneNumber}`);
            return config.phoneNumber;
          } else {
            return await this.askInput('Nhập số điện thoại (với mã quốc gia): ');
          }
        },
        password: async () => {
          if (hasValidSession) {
            Utils.log('🔐 Sử dụng 2FA từ session...');
          }
          return await this.askInput('Nhập mật khẩu 2FA (nếu có): ');
        },
        phoneCode: async () => {
          if (hasValidSession) {
            Utils.log('⚠️  Session có thể đã expired, cần mã xác nhận mới');
          }
          return await this.askInput('Nhập mã xác nhận: ');
        },
        onError: (err) => {
          Utils.log(`❌ Lỗi đăng nhập: ${err.message}`);
          throw err;
        },
      });

      // Save session string để lần sau không cần đăng nhập lại
      const currentSession = this.client.session.save();
      if (currentSession !== config.sessionString) {
        Utils.log('💾 Session string đã được cập nhật - đang lưu...');
        await this.saveSessionToConfig(currentSession);
        Utils.log('✅ Session đã được lưu vào config.js');
      }

      Utils.log('✅ Kết nối thành công!');
      return true;

    } catch (error) {
      Utils.log(`❌ Lỗi khởi tạo client: ${error.message}`);
      return false;
    }
  }

  // Helper để nhập input từ console
  askInput(question) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  // Save session string vào config.js
  async saveSessionToConfig(sessionString) {
    try {
      const fs = require('fs');
      const path = require('path');
      
      // Đọc file config hiện tại
      const configPath = path.join(__dirname, 'config.js');
      let configContent = fs.readFileSync(configPath, 'utf8');
      
      // Replace sessionString
      const regex = /sessionString:\s*['"`][^'"`]*['"`]/;
      const newSessionLine = `sessionString: '${sessionString}'`;
      
      if (regex.test(configContent)) {
        configContent = configContent.replace(regex, newSessionLine);
      } else {
        // Nếu không tìm thấy, thêm vào
        configContent = configContent.replace(
          /(apiHash:\s*['"`][^'"`]*['"`],?\s*)/,
          `$1\n  \n  sessionString: '${sessionString}',`
        );
      }
      
      // Ghi lại file
      fs.writeFileSync(configPath, configContent, 'utf8');
      
      // Update config trong memory
      config.sessionString = sessionString;
      
      return true;
    } catch (error) {
      Utils.log(`❌ Lỗi khi lưu session: ${error.message}`);
      return false;
    }
  }

  // Đăng ký event handlers
  setupEventHandlers() {
    // Đảm bảo không đăng ký handler nhiều lần
    if (this.eventHandlerRegistered) {
      Utils.log('📱 Event handlers đã được đăng ký trước đó');
      return;
    }

    // Lắng nghe tin nhắn mới
    this.client.addEventHandler(async (event) => {
      try {
        await this.handleNewMessage(event);
      } catch (error) {
        Utils.log(`❌ Lỗi xử lý tin nhắn: ${error.message}`);
      }
    }, new NewMessage({}));

    this.eventHandlerRegistered = true;
    Utils.log('📱 Đã đăng ký event handlers');
  }

  // Xử lý tin nhắn mới
  async handleNewMessage(event) {
    const message = event.message;
    if (!message) return;

    const messageText = message.message || message.text || '';
    const chatId = message.chatId;
    const messageId = message.id;
    const currentTime = Date.now();

    // Tạo unique key để track message
    const messageKey = `${chatId}_${messageId}`;
    
    // Skip nếu đã xử lý message này rồi (trong 30 giây qua)
    if (this.processedMessages.has(messageKey)) {
      const processedTime = this.processedMessages.get(messageKey);
      if (currentTime - processedTime < 30000) { // 30 seconds
        Utils.log(`🔄 Skip duplicate message: ${messageKey}`);
        return;
      }
    }

    // Skip nếu đang process message này
    if (this.processingMessages.has(messageKey)) {
      Utils.log(`⏳ Message đang được xử lý: ${messageKey}`);
      return;
    }

    // Mark as processing
    this.processingMessages.add(messageKey);

    try {
      // Kiểm tra commands trước (cho phép chính mình sử dụng commands)
      if (messageText.startsWith('/')) {
        // Mark as processed cho commands
        this.processedMessages.set(messageKey, currentTime);
        await this.handleCommand(messageText, chatId, messageId, message);
        return;
      }

      // Kiểm tra pic2 settings trước (không phụ thuộc vào replyEnabled)
      await this.checkPic2Message(message);

      // Kiểm tra nếu chức năng reply đã bật
      if (!this.settings.replyEnabled) return;

      // Kiểm tra xem có phải tin nhắn giao dịch không
      if (Utils.isTransactionMessage(messageText)) {
        // Mark as processed trước khi xử lý
        this.processedMessages.set(messageKey, currentTime);
        
        // Cho phép reply cả tin nhắn từ chính mình nếu là tin nhắn giao dịch
        await this.handleTransactionMessage(message, messageText);
      }
      // Skip các tin nhắn khác từ chính mình (outgoing)
      else if (message.out) {
        return;
      }

    } finally {
      // Remove from processing set
      this.processingMessages.delete(messageKey);
    }

    // Cleanup old processed messages (giữ 1000 messages gần nhất)
    if (this.processedMessages.size > 1000) {
      const oldEntries = Array.from(this.processedMessages.entries()).slice(0, 500);
      oldEntries.forEach(([key]) => this.processedMessages.delete(key));
    }
  }

  // Xử lý tin nhắn giao dịch
  async handleTransactionMessage(message, messageText) {
    try {
      const messageKey = `${message.chatId}_${message.id}`;
      
      Utils.log(`🔥 Bắt đầu xử lý giao dịch: ${messageKey}`);
      
      const amount = Utils.formatAmount(messageText);
      const accountInfo = Utils.extractAccountInfo(messageText);
      
      // Check if message is from self
      const fromSelf = message.out ? " (từ chính mình)" : "";
      
      Utils.log(`💰 Phát hiện giao dịch${fromSelf}: +${amount}đ từ ${accountInfo.bank} - ${accountInfo.account}`);
      
      // Double-check để tránh reply duplicate
      const replyKey = `reply_${messageKey}`;
      if (this.processedMessages.has(replyKey)) {
        Utils.log(`🚫 Đã reply message này rồi: ${messageKey}`);
        return;
      }
      
      // Mark reply as processed
      this.processedMessages.set(replyKey, Date.now());
      
      // Reply với số "1"
      await this.client.sendMessage(message.chatId, {
        message: this.settings.replyMessage,
        replyTo: message.id
      });

      Utils.log(`✅ Đã reply tin nhắn giao dịch với: "${this.settings.replyMessage}" cho ${messageKey}`);

    } catch (error) {
      Utils.log(`❌ Lỗi khi reply tin nhắn giao dịch: ${error.message}`);
    }
  }

  // Xử lý commands
  async handleCommand(messageText, chatId, messageId, originalMessage = null) {
    const commandData = Utils.parseCommand(messageText);
    if (!commandData) return;

    const { command, args } = commandData;

    switch (command) {
      case '/1':
        await this.handleReplyCommand(args, chatId, messageId);
        break;
      
      case '/status':
        await this.handleStatusCommand(chatId, messageId);
        break;
      
      case '/help':
        await this.handleHelpCommand(chatId, messageId);
        break;
      
      case '/id':
        await this.handleIdCommand(chatId, messageId, originalMessage);
        break;
      
      case '/pic2':
        await this.handlePic2Command(args, chatId, messageId);
        break;
    }
  }

  // Xử lý command /1 on/off
  async handleReplyCommand(args, chatId, messageId) {
    if (args.length === 0) {
      const status = this.settings.replyEnabled ? 'BẬT' : 'TẮT';
      await this.sendReply(chatId, messageId, `⚙️ Trạng thái hiện tại: ${status}\nDùng /1 on để bật, /1 off để tắt`);
      return;
    }

    const action = args[0].toLowerCase();
    
    if (action === 'on') {
      this.settings.replyEnabled = true;
      Utils.saveSettings(this.settings);
      Utils.log('🟢 Chức năng reply đã BẬT');
      await this.sendReply(chatId, messageId, '✅ Đã BẬT chức năng reply giao dịch');
      
    } else if (action === 'off') {
      this.settings.replyEnabled = false;
      Utils.saveSettings(this.settings);
      Utils.log('🔴 Chức năng reply đã TẮT');
      await this.sendReply(chatId, messageId, '❌ Đã TẮT chức năng reply giao dịch');
      
    } else {
      await this.sendReply(chatId, messageId, '❗ Sử dụng: /1 on hoặc /1 off');
    }
  }

  // Xử lý command /status
  async handleStatusCommand(chatId, messageId) {
    const status = this.settings.replyEnabled ? '🟢 BẬT' : '🔴 TẮT';
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    // Đếm số pic2 settings
    const pic2Count = this.settings.pic2Settings ? Object.keys(this.settings.pic2Settings).length : 0;
    const pic2Status = pic2Count > 0 ? `🟢 ${pic2Count} groups` : '🔴 TẮT';
    
    const statusMessage = `
📊 **Trạng thái UserBot**

🤖 Bot: Đang hoạt động
⚙️ Reply giao dịch: ${status}
💬 Tin nhắn reply: "${this.settings.replyMessage}"
📸 Pic2 auto reply: ${pic2Status}
⏱️ Uptime: ${hours}h ${minutes}m

📝 Commands:
/1 on - Bật reply
/1 off - Tắt reply
/status - Xem trạng thái  
/id - Xem ID chat/user
/pic2 - Cấu hình pic2
/help - Hướng dẫn
    `.trim();

    await this.sendReply(chatId, messageId, statusMessage);
  }

  // Xử lý command /help
  async handleHelpCommand(chatId, messageId) {
    const helpMessage = `
🤖 **Bank Transaction UserBot**

**Chức năng chính:**
1. Tự động phát hiện tin nhắn giao dịch ngân hàng và reply bằng số "1"
2. Tự động reply hình ảnh từ user cụ thể trong group cụ thể

**Định dạng tin nhắn giao dịch:**
- Tiền vào: +2,000 đ
- Tài khoản: 20918031 tại ACB  
- Lúc: 2025-07-20 11:10:22
- Nội dung CK: ...

**Commands - Giao dịch:**
/1 on - Bật chức năng reply giao dịch
/1 off - Tắt chức năng reply giao dịch
/1 - Xem trạng thái hiện tại

**Commands - Pic2 (Auto reply hình ảnh):**
/pic2 on [groupId] [userId/@username] [message] - Bật auto reply
/pic2 off [groupId] - Tắt auto reply cho group
/pic2 list - Xem danh sách cấu hình

**Commands - Khác:**
/status - Xem thông tin chi tiết bot
/id - Xem ID nhóm hiện tại
/id (reply) - Xem ID của user được reply
/help - Hiển thị hướng dẫn này

**Ví dụ Pic2:**
/pic2 on -1001234567890 @username Xin chào!
/pic2 on -1001234567890 123456789 Hello world!

⚠️ **Lưu ý:** 
- Bot chỉ reply tin nhắn có đầy đủ thông tin giao dịch
- Pic2 chỉ hoạt động khi user gửi hình ảnh (không phải sticker)
    `.trim();

    await this.sendReply(chatId, messageId, helpMessage);
  }

  // Xử lý command /pic2
  async handlePic2Command(args, chatId, messageId) {
    if (args.length === 0) {
      const helpText = `
📸 **Pic2 Command Usage**

/pic2 on [groupId] [userId/username] [message] - Bật auto reply hình ảnh
/pic2 off [groupId] - Tắt auto reply hình ảnh
/pic2 list - Xem danh sách settings hiện tại

**Ví dụ:**
/pic2 on -1001234567890 @username Hello world!
/pic2 on -1001234567890 123456789 Xin chào!
/pic2 off -1001234567890
      `.trim();
      
      await this.sendReply(chatId, messageId, helpText);
      return;
    }

    const action = args[0].toLowerCase();

    switch (action) {
      case 'on':
        await this.handlePic2OnCommand(args.slice(1), chatId, messageId);
        break;
      
      case 'off':
        await this.handlePic2OffCommand(args.slice(1), chatId, messageId);
        break;
      
      case 'list':
        await this.handlePic2ListCommand(chatId, messageId);
        break;
      
      default:
        await this.sendReply(chatId, messageId, '❗ Sử dụng: /pic2 on/off/list');
    }
  }

  // Xử lý /pic2 on
  async handlePic2OnCommand(args, chatId, messageId) {
    if (args.length < 3) {
      await this.sendReply(chatId, messageId, '❗ Sử dụng: /pic2 on [groupId] [userId/username] [message]');
      return;
    }

    const groupId = args[0];
    const targetUser = args[1];
    const replyMessage = args.slice(2).join(' ');

    try {
      // Validate groupId
      if (!groupId.match(/^-?\d+$/)) {
        await this.sendReply(chatId, messageId, '❌ Group ID không hợp lệ (phải là số)');
        return;
      }

      // Validate targetUser (userId hoặc username)
      let validUser = false;
      if (targetUser.startsWith('@')) {
        // Username format
        validUser = targetUser.length > 1;
      } else if (targetUser.match(/^\d+$/)) {
        // User ID format
        validUser = true;
      }

      if (!validUser) {
        await this.sendReply(chatId, messageId, '❌ User ID/Username không hợp lệ');
        return;
      }

      // Initialize pic2Settings if not exists
      if (!this.settings.pic2Settings) {
        this.settings.pic2Settings = {};
      }

      // Save settings
      this.settings.pic2Settings[groupId] = {
        enabled: true,
        targetUser: targetUser,
        replyMessage: replyMessage
      };

      Utils.saveSettings(this.settings);
      
      const userDisplay = targetUser.startsWith('@') ? targetUser : `ID: ${targetUser}`;
      const successMsg = `✅ Đã BẬT pic2 cho:\n📋 Group: \`${groupId}\`\n👤 User: ${userDisplay}\n💬 Message: "${replyMessage}"`;
      
      await this.sendReply(chatId, messageId, successMsg);
      Utils.log(`🟢 Pic2 BẬT cho group ${groupId}, user ${targetUser}`);

    } catch (error) {
      Utils.log(`❌ Lỗi khi bật pic2: ${error.message}`);
      await this.sendReply(chatId, messageId, '❌ Có lỗi xảy ra khi cấu hình pic2');
    }
  }

  // Xử lý /pic2 off
  async handlePic2OffCommand(args, chatId, messageId) {
    if (args.length < 1) {
      await this.sendReply(chatId, messageId, '❗ Sử dụng: /pic2 off [groupId]');
      return;
    }

    const groupId = args[0];

    try {
      // Validate groupId
      if (!groupId.match(/^-?\d+$/)) {
        await this.sendReply(chatId, messageId, '❌ Group ID không hợp lệ (phải là số)');
        return;
      }

      // Initialize pic2Settings if not exists
      if (!this.settings.pic2Settings) {
        this.settings.pic2Settings = {};
      }

      // Check if settings exists
      if (!this.settings.pic2Settings[groupId]) {
        await this.sendReply(chatId, messageId, `❌ Không tìm thấy cấu hình pic2 cho group: \`${groupId}\``);
        return;
      }

      // Remove settings
      delete this.settings.pic2Settings[groupId];
      Utils.saveSettings(this.settings);
      
      await this.sendReply(chatId, messageId, `✅ Đã TẮT pic2 cho group: \`${groupId}\``);
      Utils.log(`🔴 Pic2 TẮT cho group ${groupId}`);

    } catch (error) {
      Utils.log(`❌ Lỗi khi tắt pic2: ${error.message}`);
      await this.sendReply(chatId, messageId, '❌ Có lỗi xảy ra khi tắt pic2');
    }
  }

  // Xử lý /pic2 list
  async handlePic2ListCommand(chatId, messageId) {
    try {
      if (!this.settings.pic2Settings || Object.keys(this.settings.pic2Settings).length === 0) {
        await this.sendReply(chatId, messageId, '📝 Chưa có cấu hình pic2 nào');
        return;
      }

      let listMsg = '📸 **Danh sách Pic2 Settings**\n\n';
      
      for (const [groupId, config] of Object.entries(this.settings.pic2Settings)) {
        const status = config.enabled ? '🟢 BẬT' : '🔴 TẮT';
        const userDisplay = config.targetUser.startsWith('@') ? config.targetUser : `ID: ${config.targetUser}`;
        
        listMsg += `**Group:** \`${groupId}\`\n`;
        listMsg += `**Status:** ${status}\n`;
        listMsg += `**User:** ${userDisplay}\n`;
        listMsg += `**Message:** "${config.replyMessage}"\n\n`;
      }

      await this.sendReply(chatId, messageId, listMsg.trim());

    } catch (error) {
      Utils.log(`❌ Lỗi khi xem danh sách pic2: ${error.message}`);
      await this.sendReply(chatId, messageId, '❌ Có lỗi xảy ra khi xem danh sách');
    }
  }

  // Xử lý command /id
  async handleIdCommand(chatId, messageId, originalMessage = null) {
    try {
      // Kiểm tra xem có phải là reply không
      if (originalMessage && originalMessage.replyTo) {
        // Đây là reply vào tin nhắn khác, lấy thông tin user được reply
        await this.handleUserIdCommand(chatId, messageId, originalMessage);
      } else {
        // Không phải reply, hiển thị thông tin chat/nhóm
        await this.handleChatIdCommand(chatId, messageId);
      }
    } catch (error) {
      Utils.log(`❌ Lỗi khi xử lý command /id: ${error.message}`);
      await this.sendReply(chatId, messageId, `❌ Có lỗi xảy ra khi lấy thông tin ID`);
    }
  }

  // Xử lý lệnh /id khi reply vào tin nhắn của user khác
  async handleUserIdCommand(chatId, messageId, originalMessage) {
    try {
      // Lấy tin nhắn được reply
      const replyToMsgId = originalMessage.replyTo.replyToMsgId;
      const messages = await this.client.getMessages(chatId, {
        ids: [replyToMsgId]
      });

      if (messages && messages.length > 0) {
        const repliedMessage = messages[0];
        const sender = repliedMessage.sender;
        
        if (sender) {
          let userInfo = `👤 **Thông tin User**\n\n`;
          userInfo += `🆔 User ID: \`${sender.id.toString()}\`\n`;
          
          // Tên người dùng
          if (sender.firstName) {
            let fullName = sender.firstName;
            if (sender.lastName) {
              fullName += ` ${sender.lastName}`;
            }
            userInfo += `📝 Tên: ${fullName}\n`;
          }
          
          // Username
          if (sender.username) {
            userInfo += `🔗 Username: @${sender.username}\n`;
          }
          
          // Phone (nếu có và public)
          if (sender.phone) {
            userInfo += `📞 Phone: +${sender.phone}\n`;
          }
          
          // Trạng thái
          if (sender.bot) {
            userInfo += `🤖 Bot: Có\n`;
          }
          
          if (sender.verified) {
            userInfo += `✅ Verified: Có\n`;
          }
          
          if (sender.premium) {
            userInfo += `⭐ Premium: Có\n`;
          }

          await this.sendReply(chatId, messageId, userInfo);
        } else {
          await this.sendReply(chatId, messageId, `❌ Không thể lấy thông tin người gửi tin nhắn được reply`);
        }
      } else {
        await this.sendReply(chatId, messageId, `❌ Không tìm thấy tin nhắn được reply`);
      }
    } catch (error) {
      Utils.log(`❌ Lỗi khi lấy thông tin user: ${error.message}`);
      await this.sendReply(chatId, messageId, `❌ Không thể lấy thông tin user được reply`);
    }
  }

  // Xử lý lệnh /id khi không reply (hiển thị thông tin chat)
  async handleChatIdCommand(chatId, messageId) {
    try {
      // Lấy thông tin về chat hiện tại
      const chat = await this.client.getEntity(chatId);
      
      let chatInfo = `🆔 **ID Chat hiện tại**\n\n`;
      chatInfo += `📋 Chat ID: \`${chatId.toString()}\`\n`;
      
      // Thêm thông tin chi tiết về chat nếu có thể
      if (chat.title) {
        chatInfo += `📝 Tên nhóm: ${chat.title}\n`;
      }
      
      if (chat.username) {
        chatInfo += `🔗 Username: @${chat.username}\n`;
      }
      
      // Xác định loại chat
      let chatType = 'Chat cá nhân';
      if (chat.broadcast) {
        chatType = 'Kênh (Channel)';
      } else if (chat.megagroup) {
        chatType = 'Siêu nhóm (Supergroup)';
      } else if (chat.title && !chat.megagroup) {
        chatType = 'Nhóm thường';
      }
      
      chatInfo += `📂 Loại: ${chatType}`;
      
      await this.sendReply(chatId, messageId, chatInfo);
      
    } catch (error) {
      Utils.log(`❌ Lỗi khi lấy thông tin chat: ${error.message}`);
      await this.sendReply(chatId, messageId, `❌ Không thể lấy thông tin chat\n\n📋 Chat ID: \`${chatId.toString()}\``);
    }
  }

  // Kiểm tra và xử lý pic2 message
  async checkPic2Message(message) {
    try {
      // Kiểm tra có pic2Settings không
      if (!this.settings.pic2Settings || Object.keys(this.settings.pic2Settings).length === 0) {
        return;
      }

      const chatId = message.chatId.toString();
      const pic2Config = this.settings.pic2Settings[chatId];

      // Kiểm tra có config cho group này không
      if (!pic2Config || !pic2Config.enabled) {
        return;
      }

      // Kiểm tra tin nhắn có hình ảnh không
      if (!Utils.hasPhoto(message)) {
        return;
      }

      // Lấy thông tin sender
      const sender = message.sender;
      if (!sender) {
        return;
      }

      // Kiểm tra có phải target user không
      if (!Utils.isTargetUser(sender, pic2Config.targetUser)) {
        return;
      }

      // Tạo unique key để tránh duplicate
      const pic2Key = `pic2_${chatId}_${message.id}`;
      
      // Kiểm tra đã process chưa
      if (this.processedMessages.has(pic2Key)) {
        return;
      }

      // Mark as processed
      this.processedMessages.set(pic2Key, Date.now());

      // Reply với message đã cấu hình
      await this.client.sendMessage(message.chatId, {
        message: pic2Config.replyMessage,
        replyTo: message.id
      });

      const userDisplay = sender.username ? `@${sender.username}` : `ID: ${sender.id}`;
      Utils.log(`📸 Pic2 reply: ${userDisplay} gửi hình trong group ${chatId} -> reply: "${pic2Config.replyMessage}"`);

    } catch (error) {
      Utils.log(`❌ Lỗi khi xử lý pic2: ${error.message}`);
    }
  }

  // Helper để send reply
  async sendReply(chatId, messageId, text) {
    try {
      await this.client.sendMessage(chatId, {
        message: text,
        replyTo: messageId
      });
    } catch (error) {
      Utils.log(`❌ Lỗi khi send reply: ${error.message}`);
    }
  }

  // Kiểm tra instance khác
  checkSingleInstance() {
    const fs = require('fs');
    const pidFile = './bot.pid';
    
    try {
      if (fs.existsSync(pidFile)) {
        const oldPid = fs.readFileSync(pidFile, 'utf8').trim();
        
        // Kiểm tra nếu process cũ vẫn đang chạy
        try {
          process.kill(oldPid, 0); // Check if process exists
          Utils.log(`⚠️  Phát hiện bot khác đang chạy (PID: ${oldPid})`);
          Utils.log('🛑 Vui lòng dừng bot cũ trước khi chạy bot mới');
          process.exit(1);
        } catch (e) {
          // Process không tồn tại, có thể xóa file cũ
          Utils.log('🧹 Dọn dệp PID file cũ');
          fs.unlinkSync(pidFile);
        }
      }
      
      // Tạo PID file mới
      fs.writeFileSync(pidFile, process.pid.toString());
      Utils.log(`📝 Tạo PID file: ${process.pid}`);
      
    } catch (error) {
      Utils.log(`❌ Lỗi kiểm tra instance: ${error.message}`);
    }
  }

  // Cleanup khi thoát
  cleanup() {
    const fs = require('fs');
    const pidFile = './bot.pid';
    
    try {
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
        Utils.log('🧹 Đã xóa PID file');
      }
    } catch (error) {
      Utils.log(`❌ Lỗi cleanup: ${error.message}`);
    }
  }

  // Khởi chạy bot
  async start() {
    try {
      Utils.log('🚀 Khởi động Bank Transaction UserBot...');
      
      // Kiểm tra single instance
      this.checkSingleInstance();
      
      // Khởi tạo client
      const clientInitialized = await this.initializeClient();
      if (!clientInitialized) {
        throw new Error('Không thể khởi tạo Telegram client');
      }

      // Đăng ký event handlers
      this.setupEventHandlers();

      // Get thông tin user
      const me = await this.client.getMe();
      Utils.log(`👤 Đăng nhập như: ${me.firstName} ${me.lastName || ''} (@${me.username || 'no_username'})`);

      this.isRunning = true;
      Utils.log('✅ UserBot đã sẵn sàng hoạt động!');
      Utils.log('📝 Gõ /help trong bất kỳ chat nào để xem hướng dẫn');
      Utils.log(`🔄 Duplicate protection: ACTIVE`);
      Utils.log(`📊 Process ID: ${process.pid}`);

      // Keep alive
      while (this.isRunning) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

    } catch (error) {
      Utils.log(`❌ Lỗi khi khởi chạy bot: ${error.message}`);
      this.cleanup();
      process.exit(1);
    }
  }

  // Dừng bot
  stop() {
    Utils.log('🛑 Đang dừng bot...');
    this.isRunning = false;
    if (this.client) {
      this.client.disconnect();
    }
    this.cleanup();
  }
}

// Khởi chạy bot
const bot = new BankTransactionUserbot();

// Handle process signals
process.on('SIGINT', () => {
  Utils.log('📤 Nhận tín hiệu SIGINT, đang dừng bot...');
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  Utils.log('📤 Nhận tín hiệu SIGTERM, đang dừng bot...');
  bot.stop();
  process.exit(0);
});

// Bắt lỗi không được handle
process.on('unhandledRejection', (reason, promise) => {
  Utils.log('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  Utils.log('❌ Uncaught Exception:', error);
  process.exit(1);
});

// Start bot
bot.start(); 