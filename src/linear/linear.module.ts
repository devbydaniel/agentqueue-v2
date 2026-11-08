import { Global, Module } from '@nestjs/common';
import { LinearAuthService } from './linear-auth.service.js';

@Global()
@Module({
  providers: [LinearAuthService],
  exports: [LinearAuthService],
})
export class LinearModule {}
