import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Set up global request validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strips out properties that do not have validation decorators
      transform: true, // Automatically converts payloads to DTO instance objects
      forbidNonWhitelisted: true, // Rejects requests containing unrecognized properties
    }),
  );

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
}
bootstrap();
