import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { EnqueueRunDto } from './dto/enqueue-run.dto.js';
import { RunsService } from './runs.service.js';

@ApiTags('Runs')
@Controller('runs')
export class RunsController {
  constructor(private readonly runsService: RunsService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Enqueue an async agent run',
    description:
      'Creates a run record, enqueues it for async processing, and returns immediately with the run ID. Poll GET /runs/:id for status.',
  })
  @ApiResponse({
    status: 202,
    description: 'Run enqueued for async processing',
  })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  async enqueueRun(@Body() dto: EnqueueRunDto) {
    return this.runsService.enqueue({ ...dto, source: 'manual' });
  }
}
