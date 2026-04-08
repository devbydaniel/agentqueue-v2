import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

export class EnqueueRunDto {
  @IsString()
  @IsNotEmpty()
  repo!: string;

  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @IsString()
  @IsOptional()
  prependSystemPrompt?: string;

  @IsString()
  @IsOptional()
  appendSystemPrompt?: string;

  @IsInt()
  @IsPositive()
  @IsOptional()
  timeoutMs?: number;
}
