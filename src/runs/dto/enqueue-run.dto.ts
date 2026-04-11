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
  cwd!: string;

  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @IsString()
  @IsOptional()
  appendSystemPrompt?: string;

  @IsInt()
  @IsPositive()
  @IsOptional()
  timeoutMs?: number;
}
