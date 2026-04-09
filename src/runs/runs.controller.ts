import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { EnqueueRunDto } from './dto/enqueue-run.dto.js';
import { ListRunEventsDto } from './dto/list-run-events.dto.js';
import { ListRunsDto } from './dto/list-runs.dto.js';
import { RunsService } from './runs.service.js';

@ApiTags('Runs')
@ApiBearerAuth()
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

  @Get()
  @ApiOperation({
    summary: 'List runs',
    description:
      'Returns a paginated list of runs, optionally filtered by status, source, cwd, or trigger.',
  })
  @ApiResponse({ status: 200, description: 'List of runs' })
  async listRuns(@Query() query: ListRunsDto) {
    return this.runsService.listRuns(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a run by ID',
    description: 'Returns the full run record including current status.',
  })
  @ApiResponse({ status: 200, description: 'Run details' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async getRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.runsService.getRun(id);
  }

  @Get(':id/events')
  @ApiOperation({
    summary: 'List events for a run',
    description:
      'Returns the filtered event log for a specific run, ordered chronologically.',
  })
  @ApiResponse({ status: 200, description: 'List of run events' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async listRunEvents(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListRunEventsDto,
  ) {
    return this.runsService.listRunEvents(id, {
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Post(':id/abort')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Abort a run',
    description:
      'Aborts a running or waiting run. Returns 409 if the run is already in a terminal state.',
  })
  @ApiResponse({ status: 200, description: 'Abort result' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  @ApiResponse({ status: 409, description: 'Run already in terminal state' })
  async abortRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.runsService.abortRun(id);
  }
}
