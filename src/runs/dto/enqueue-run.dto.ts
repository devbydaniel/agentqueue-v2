import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class EnqueueRunDto {
  @IsString()
  @IsNotEmpty()
  repo!: string;

  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @IsString()
  @IsOptional()
  sessionKey?: string;

  @IsString()
  @IsOptional()
  prependSystemPrompt?: string;

  @IsString()
  @IsOptional()
  appendSystemPrompt?: string;
}
