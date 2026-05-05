import { relations } from "drizzle-orm/relations";
import { tasks, agents, teams, teamMembers, notifications } from "./schema";

export const tasksRelations = relations(tasks, ({one, many}) => ({
	task: one(tasks, {
		fields: [tasks.parentTaskId],
		references: [tasks.id],
		relationName: "tasks_parentTaskId_tasks_id"
	}),
	tasks: many(tasks, {
		relationName: "tasks_parentTaskId_tasks_id"
	}),
	agent: one(agents, {
		fields: [tasks.sessionId],
		references: [agents.sessionId]
	}),
	notifications: many(notifications),
}));

export const agentsRelations = relations(agents, ({many}) => ({
	tasks: many(tasks),
}));

export const teamMembersRelations = relations(teamMembers, ({one}) => ({
	team: one(teams, {
		fields: [teamMembers.teamName],
		references: [teams.name]
	}),
}));

export const teamsRelations = relations(teams, ({many}) => ({
	teamMembers: many(teamMembers),
}));

export const notificationsRelations = relations(notifications, ({one}) => ({
	task: one(tasks, {
		fields: [notifications.taskId],
		references: [tasks.id]
	}),
}));