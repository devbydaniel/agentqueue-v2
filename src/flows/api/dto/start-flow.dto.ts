import { IsObject, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class StartFlowDto {
  @ApiPropertyOptional({
    description: 'Variables to pass to the flow resolver',
    example: { task: 'feat-123', branch: 'main' },
  })
  @IsOptional()
  @IsObject()
  vars?: Record<string, string>;
}
