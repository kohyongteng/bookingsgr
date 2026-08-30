const lib = require('./lib');

(async () => {
  const gmail = lib.getGmailClient('airbnb');
  const profile = await gmail.users.getProfile({ userId: 'me' });
  console.log('Authenticated as:', profile.data.emailAddress);
})();
