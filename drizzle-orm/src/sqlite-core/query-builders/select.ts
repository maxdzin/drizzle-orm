import { Placeholder, Query, SQL, SQLWrapper } from '~/sql';
import { AnySQLiteColumn } from '~/sqlite-core/columns';
import { SQLiteDialect } from '~/sqlite-core/dialect';
import { Table } from '~/table';

import { PreparedQuery, SQLiteSession } from '~/sqlite-core/session';
import { AnySQLiteTable, GetTableConfig } from '~/sqlite-core/table';

import {
	GetSubquerySelection,
	Subquery,
	SubqueryConfig,
	SubquerySelectionProxyHandler,
	SubqueryWithSelection,
} from '~/subquery';
import { orderSelectedFields, Simplify } from '~/utils';
import { getTableColumns } from '../utils';
import {
	AnySQLiteSelect,
	BuildSubquerySelection,
	GetSelectTableName,
	JoinFn,
	JoinNullability,
	JoinType,
	SelectFields,
	SelectMode,
	SelectResult,
	SQLiteSelectConfig,
} from './select.types';

export class SQLiteSelectBuilder<
	TSelection extends SelectFields | undefined,
	TResultType extends 'sync' | 'async',
	TRunResult,
> {
	constructor(
		private fields: TSelection,
		private session: SQLiteSession,
		private dialect: SQLiteDialect,
	) {}

	from<TSubquery extends Subquery>(
		subquery: TSubquery,
	): SQLiteSelect<
		TSubquery,
		TResultType,
		TRunResult,
		TSelection extends undefined ? GetSubquerySelection<TSubquery> : TSelection,
		TSelection extends undefined ? 'single' : 'partial'
	>;
	from<TTable extends AnySQLiteTable>(
		table: TTable,
	): SQLiteSelect<
		TTable,
		TResultType,
		TRunResult,
		TSelection extends undefined ? GetTableConfig<TTable, 'columns'> : TSelection,
		TSelection extends undefined ? 'single' : 'partial'
	>;
	from(table: AnySQLiteTable | Subquery): AnySQLiteSelect {
		const isPartialSelect = !!this.fields;
		const fields = this.fields ?? (table instanceof Subquery
			? table[SubqueryConfig].selection as SelectFields
			: getTableColumns(table, { format: 'object' }));
		const fieldsList = orderSelectedFields<AnySQLiteColumn>(fields);
		return new SQLiteSelect(table, fields, fieldsList, isPartialSelect, this.session, this.dialect);
	}
}

export interface SQLiteSelect<
	TTable extends AnySQLiteTable | Subquery,
	TResultType extends 'sync' | 'async',
	TRunResult,
	TSelection,
	TSelectMode extends SelectMode = 'single',
	TNullability extends Record<string, JoinNullability> = Record<GetSelectTableName<TTable>, 'not-null'>,
> extends SQLWrapper {}

export class SQLiteSelect<
	TTable extends AnySQLiteTable | Subquery,
	TResultType extends 'sync' | 'async',
	TRunResult,
	TSelection,
	TSelectMode extends SelectMode = 'single',
	TNullability extends Record<string, JoinNullability> = Record<GetSelectTableName<TTable>, 'not-null'>,
> implements SQLWrapper {
	declare protected $table: TTable;
	declare protected $selectMode: TSelectMode;
	declare protected $result: TSelection;

	private config: SQLiteSelectConfig;
	private joinsNotNullable: Record<string, boolean>;
	private tableName: string;

	constructor(
		table: SQLiteSelectConfig['table'],
		fields: SQLiteSelectConfig['fields'],
		fieldsList: SQLiteSelectConfig['fieldsList'],
		private isPartialSelect: boolean,
		private session: SQLiteSession,
		private dialect: SQLiteDialect,
	) {
		this.config = {
			table,
			fields,
			fieldsList,
			joins: {},
			orderBy: [],
			groupBy: [],
		};
		this.tableName = table instanceof Subquery ? table[SubqueryConfig].alias : table[Table.Symbol.Name];
		this.joinsNotNullable = { [this.tableName]: true };
	}

	private createJoin<TJoinType extends JoinType>(
		joinType: TJoinType,
	): JoinFn<TTable, TResultType, TRunResult, TSelectMode, TJoinType, TSelection, TNullability> {
		return (table: AnySQLiteTable | Subquery, on: SQL | undefined): AnySQLiteSelect => {
			const tableName = table instanceof Subquery ? table[SubqueryConfig].alias : table[Table.Symbol.Name];

			if (this.config.joins[tableName]) {
				throw new Error(`Alias "${tableName}" is already used in this query`);
			}

			if (!this.isPartialSelect) {
				// If this is the first join and this is not a partial select, "move" the fields from the main table to the nested object
				if (Object.keys(this.joinsNotNullable).length === 1) {
					this.config.fieldsList = this.config.fieldsList.map((field) => ({
						...field,
						path: [this.tableName, ...field.path],
					}));
				}
				this.config.fieldsList.push(
					...orderSelectedFields<AnySQLiteColumn>(
						table instanceof Subquery ? table[SubqueryConfig].selection : table[Table.Symbol.Columns],
						[tableName],
					),
				);
			}

			this.config.joins[tableName] = { on, table, joinType };

			switch (joinType) {
				case 'left':
					this.joinsNotNullable[tableName] = false;
					break;
				case 'right':
					this.joinsNotNullable = Object.fromEntries(
						Object.entries(this.joinsNotNullable).map(([key]) => [key, false]),
					);
					this.joinsNotNullable[tableName] = true;
					break;
				case 'inner':
					this.joinsNotNullable[tableName] = true;
					break;
				case 'full':
					this.joinsNotNullable = Object.fromEntries(
						Object.entries(this.joinsNotNullable).map(([key]) => [key, false]),
					);
					this.joinsNotNullable[tableName] = false;
					break;
			}

			return this;
		};
	}

	leftJoin = this.createJoin('left');

	rightJoin = this.createJoin('right');

	innerJoin = this.createJoin('inner');

	fullJoin = this.createJoin('full');

	where(where: SQL | undefined): Omit<this, 'where' | `${JoinType}Join`> {
		this.config.where = where;
		return this;
	}

	orderBy(...columns: (AnySQLiteColumn | SQL)[]): Omit<this, 'where' | `${JoinType}Join` | 'orderBy'> {
		this.config.orderBy = columns;
		return this;
	}

	groupBy(...columns: (AnySQLiteColumn | SQL)[]): Omit<this, 'where' | `${JoinType}Join`> {
		this.config.groupBy = columns;
		return this;
	}

	limit(limit: number | Placeholder): Omit<this, 'where' | `${JoinType}Join` | 'limit'> {
		this.config.limit = limit;
		return this;
	}

	offset(offset: number | Placeholder): Omit<this, 'where' | `${JoinType}Join` | 'offset'> {
		this.config.offset = offset;
		return this;
	}

	/** @internal */
	getSQL(): SQL {
		return this.dialect.buildSelectQuery(this.config);
	}

	toSQL(): Omit<Query, 'typings'> {
		const { typings, ...rest } = this.dialect.sqlToQuery(this.getSQL());
		return rest;
	}

	prepare(): PreparedQuery<
		{
			type: TResultType;
			run: TRunResult;
			all: SelectResult<TSelection, TSelectMode, TNullability>[];
			get: SelectResult<TSelection, TSelectMode, TNullability>;
			values: any[][];
		}
	> {
		const query = this.session.prepareQuery(this.dialect.sqlToQuery(this.getSQL()), this.config.fieldsList);
		query.joinsNotNullableMap = this.joinsNotNullable;
		return query;
	}

	run: ReturnType<this['prepare']>['run'] = (placeholderValues) => {
		return this.prepare().run(placeholderValues);
	};

	all: ReturnType<this['prepare']>['all'] = (placeholderValues) => {
		return this.prepare().all(placeholderValues);
	};

	get: ReturnType<this['prepare']>['get'] = (placeholderValues) => {
		return this.prepare().get(placeholderValues);
	};

	values: ReturnType<this['prepare']>['values'] = (placeholderValues) => {
		return this.prepare().values(placeholderValues);
	};

	subquery<TAlias extends string>(
		alias: TAlias,
	): SubqueryWithSelection<Simplify<BuildSubquerySelection<TSelection, TAlias, TNullability>>, TAlias> {
		return new Proxy(
			new Subquery(this.getSQL(), this.config.fields, alias),
			new SubquerySelectionProxyHandler(alias),
		) as SubqueryWithSelection<Simplify<BuildSubquerySelection<TSelection, TAlias, TNullability>>, TAlias>;
	}
}