import 'dotenv/config';
import { WhatsappListener } from './whatsapp-listener.service.js';

async function bootstrap() {
  const listener = new WhatsappListener();
  await listener.start();
}

bootstrap();
