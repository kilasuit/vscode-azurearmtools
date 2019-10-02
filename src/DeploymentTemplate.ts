// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation.  All rights reserved.
// ----------------------------------------------------------------------------

import { AzureRMAssets, FunctionsMetadata } from "./AzureRMAssets";
import { CachedPromise } from "./CachedPromise";
import { CachedValue } from "./CachedValue";
import { assert } from "./fixed_assert";
import { Histogram } from "./Histogram";
import { IParameterDefinition } from "./IParameterDefinition";
import * as Json from "./JSON";
import * as language from "./Language";
import { ParameterDefinition } from "./ParameterDefinition";
import { PositionContext } from "./PositionContext";
import * as Reference from "./Reference";
import { isArmSchema } from "./supported";
import { ScopeContext, TemplateScope } from "./TemplateScope";
import * as TLE from "./TLE";
import { UserFunctionNamespaceDefinition } from "./UserFunctionNamespaceDefinition";
import * as Utilities from "./Utilities";
import * as FindReferencesVisitor from "./visitors/FindReferencesVisitor";
import * as FunctionCountVisitor from "./visitors/FunctionCountVisitor";
import { GenericStringVisitor } from "./visitors/GenericStringVisitor";
import * as IncorrectFunctionArgumentCountVisitor from "./visitors/IncorrectFunctionArgumentCountVisitor";
import { ReferenceInVariableDefinitionsVisitor } from "./visitors/ReferenceInVariableDefinitionsVisitor";
import { UndefinedParameterAndVariableVisitor } from "./visitors/UndefinedParameterAndVariableVisitor";
import * as UndefinedVariablePropertyVisitor from "./visitors/UndefinedVariablePropertyVisitor";
import * as UnrecognizedFunctionVisitor from "./visitors/UnrecognizedFunctionVisitor";

export class DeploymentTemplate {
    // Parse result for the template JSON document as a whole
    private _jsonParseResult: Json.ParseResult;

    // The top-level parameters and variables (as opposed to those in user functions and deployment resources)
    private _topLevelScope: TemplateScope;

    // asdf
    private _topLevelValue: Json.ObjectValue | null;

    // A list of all JSON tokens in the template that represent quoted strings
    private _jsonQuotedStringTokens: CachedValue<Json.Token[]> = new CachedValue<Json.Token[]>();

    // A map from all quoted string values (not including the surrounding quotes) to their
    //   cached TLE parse results.
    private _quotedStringToTleParseResultMap: CachedValue<Map<string, TLE.ParseResult>> = new CachedValue<Map<string, TLE.ParseResult>>();

    // All errors and warnings in the template
    private _errors: CachedPromise<language.Issue[]> = new CachedPromise<language.Issue[]>();
    private _warnings: CachedValue<language.Issue[]> = new CachedValue<language.Issue[]>();

    private _schemaUri: CachedValue<string | null> = new CachedValue<string | null>();

    /**
     * Create a new DeploymentTemplate object.
     *
     * @param _documentText The string text of the document.
     * @param _documentId A unique identifier for this document. Usually this will be a URI to the document.
     */
    constructor(private _documentText: string, private _documentId: string) {
        assert(_documentText !== null);
        assert(_documentText !== undefined);
        assert(_documentId);

        this._jsonParseResult = Json.parse(_documentText);
        this._topLevelValue = Json.asObjectValue(this._jsonParseResult.value);

        this._topLevelScope = new TemplateScope(
            ScopeContext.TopLevel,
            this.getTopLevelParameterDefinitions(),
            this.getTopLevelVariableDefinitions(),
            this.getTopLevelNamespaceDefinitions(),
            'Top-level scope');
    }

    public get topLevelScope(): TemplateScope {
        return this._topLevelScope;
    }

    public hasArmSchemaUri(): boolean {
        return isArmSchema(this.schemaUri);
    }

    /**
     * A list of all JSON tokens in the template that represent quoted strings
     */
    // asdf: should probably just use the string map instead of this
    private get jsonQuotedStringTokens(): Json.Token[] {
        return this._jsonQuotedStringTokens.getOrCacheValue(() => {
            const jsonQuotedStringTokens: Json.Token[] = [];

            for (const jsonToken of this._jsonParseResult.tokens) {
                if (jsonToken.type === Json.TokenType.QuotedString) {
                    jsonQuotedStringTokens.push(jsonToken);
                }
            }

            return jsonQuotedStringTokens;
        });
    }

    /**
     * Parses all JSON strings in the template and cache the resulting TLE.ParseResult.
     * Tries to avoid parsing the exact same expression string more than once for a given scope.
     * Returns a map that maps from the unquoted string to the parse result.
     *
     * asdf Should be more lazy?
     * asdf should it map from the token instead?
     */
    private get quotedStringToTleParseResultMap(): Map<string, TLE.ParseResult> {
        // tslint:disable-next-line: no-this-assignment
        const that = this;

        // tslint:disable-next-line: max-func-body-length //asdf
        return this._quotedStringToTleParseResultMap.getOrCacheValue(() => {
            const quotedStringToTleParseResultMap = new Map<string, TLE.ParseResult>();

            const paramDefaultValuesScope = new TemplateScope(
                ScopeContext.ParameterDefaultValue,
                this._topLevelScope.parameterDefinitions,
                this.topLevelScope.variableDefinitions,
                this.topLevelScope.namespaceDefinitions,
                'Top-level parameter default value scope'
            ); //asdf

            for (let param of this.parameterDefinitions) {
                if (param.defaultValue) {
                    parseExpressionsByScope(param.defaultValue, paramDefaultValuesScope); //testpoint
                }
            }

            for (let ns of this.namespaceDefinitions) {
                for (let member of ns.members) {
                    if (member.output) {
                        const userFunctionScope = new TemplateScope(
                            ScopeContext.UserFunction, //asdf?
                            // User functions can only use their own parameters, they do
                            //   not have access to top-level parameters
                            member.parameterDefinitions,
                            undefined, // variable references not supported
                            undefined, // nested user functions not supported
                            `Scope for user function ${member.name.toString()}`
                        );
                        parseExpressionsByScope(member.output.value, userFunctionScope);
                    }
                }
            }

            // All other strings have top-level scope
            for (let jsonQuotedStringToken of this.jsonQuotedStringTokens) {
                const unquoted: string = Utilities.unquote(jsonQuotedStringToken.toString()); // not positive about this - "\"" is turning into empty string
                if (!quotedStringToTleParseResultMap.has(unquoted)) {
                    let tleParseResult: TLE.ParseResult = TLE.Parser.parse(jsonQuotedStringToken.toString(), this.topLevelScope);
                    // Cache the results of this parse by the string's value // asdf: can't map by string value, they might be in different scopes, getting different results.  Need to cache by string and scope
                    quotedStringToTleParseResultMap.set(unquoted, tleParseResult);
                }
            }

            return quotedStringToTleParseResultMap;

            function parseExpressionsByScope(value: Json.Value | null, scope: TemplateScope): void {
                if (value) {
                    GenericStringVisitor.visit(
                        value,
                        stringValue => {
                            // asdf better way to go from Json.Value to Json.Token?
                            // Wny not just use the string value from the Json.Value?
                            let jsonQuotedStringToken: Json.Token | null = that.getJSONTokenAtDocumentCharacterIndex(stringValue.span.startIndex);
                            assert(!!jsonQuotedStringToken, "Expected token at this location, because the location came from a StringValue from the JSON parse");

                            // tslint:disable-next-line:no-non-null-assertion // Asserted
                            jsonQuotedStringToken = jsonQuotedStringToken!;
                            assert(jsonQuotedStringToken.type === Json.TokenType.QuotedString, "Expected quoted string token");

                            const unquoted = Utilities.unquote(jsonQuotedStringToken.toString());
                            if (!quotedStringToTleParseResultMap.has(unquoted)) {
                                // Parse the string as a possible TLE expression
                                let tleParseResult: TLE.ParseResult = TLE.Parser.parse(
                                    jsonQuotedStringToken.toString(),
                                    scope
                                );

                                // Cache the results of this parse by the string's value without the quotes
                                // asdf: can't map by string value, they might be in different scopes, getting different results.  Need to cache by string and scope
                                quotedStringToTleParseResultMap.set(unquoted, tleParseResult);
                            }
                        });
                }
            }
        });
    }

    /**
     * Get the document text as a string.
     */
    public get documentText(): string {
        return this._documentText;
    }

    /**
     * The unique identifier for this deployment template. Usually this will be a URI to the document.
     */
    public get documentId(): string {
        return this._documentId;
    }

    public get schemaUri(): string | null {
        return this._schemaUri.getOrCacheValue(() => {
            const value: Json.ObjectValue | null = Json.asObjectValue(this._jsonParseResult.value);
            if (value) {
                const schema: Json.Value | null = Json.asStringValue(value.getPropertyValue("$schema"));
                if (schema) {
                    return schema.toString();
                }
            }

            return null;
        });
    }

    public get errors(): Promise<language.Issue[]> {
        return this._errors.getOrCachePromise(async () => {
            // tslint:disable-next-line:typedef
            return new Promise<language.Issue[]>(async (resolve, reject) => {
                try {
                    let functions: FunctionsMetadata = await AzureRMAssets.getFunctionsMetadata();
                    const parseErrors: language.Issue[] = [];

                    // Loop through each string in the template
                    for (const jsonQuotedStringToken of this.jsonQuotedStringTokens) {
                        const jsonTokenStartIndex: number = jsonQuotedStringToken.span.startIndex;

                        const tleParseResult: TLE.ParseResult | null = this.getTLEParseResultFromJSONToken(jsonQuotedStringToken);
                        if (tleParseResult) {
                            const expressionScope: TemplateScope = tleParseResult.scope;

                            for (const error of tleParseResult.errors) {
                                parseErrors.push(error.translate(jsonTokenStartIndex));
                            }

                            const tleExpression: TLE.Value | null = tleParseResult.expression;

                            // Undefined parameter/variable references
                            const tleUndefinedParameterAndVariableVisitor =
                                UndefinedParameterAndVariableVisitor.visit(
                                    tleExpression,
                                    tleParseResult.scope); // asdf better error message?
                            for (const error of tleUndefinedParameterAndVariableVisitor.errors) {
                                parseErrors.push(error.translate(jsonTokenStartIndex));
                            }

                            // Unrecognized function calls
                            const tleUnrecognizedFunctionVisitor = UnrecognizedFunctionVisitor.UnrecognizedFunctionVisitor.visit(this._topLevelScope/*asdf?*/, tleExpression, functions);
                            for (const error of tleUnrecognizedFunctionVisitor.errors) {
                                parseErrors.push(error.translate(jsonTokenStartIndex));
                            }

                            // Incorrect number of function arguments
                            const tleIncorrectArgumentCountVisitor = IncorrectFunctionArgumentCountVisitor.IncorrectFunctionArgumentCountVisitor.visit(tleExpression, functions, expressionScope);
                            for (const error of tleIncorrectArgumentCountVisitor.errors) {
                                parseErrors.push(error.translate(jsonTokenStartIndex));
                            }

                            // Undefined variable properties
                            const tleUndefinedVariablePropertyVisitor = UndefinedVariablePropertyVisitor.UndefinedVariablePropertyVisitor.visit(tleExpression, expressionScope);
                            for (const error of tleUndefinedVariablePropertyVisitor.errors) {
                                parseErrors.push(error.translate(jsonTokenStartIndex));
                            }
                        }
                    }

                    const deploymentTemplateObject: Json.ObjectValue | null = Json.asObjectValue(this.jsonParseResult.value);
                    if (deploymentTemplateObject) {
                        const variablesObject: Json.ObjectValue | null = Json.asObjectValue(deploymentTemplateObject.getPropertyValue("variables"));
                        if (variablesObject) {
                            const referenceInVariablesFinder = new ReferenceInVariableDefinitionsVisitor(this);
                            variablesObject.accept(referenceInVariablesFinder);

                            // Can't call reference() inside variable definitions //asdf scopes
                            for (const referenceSpan of referenceInVariablesFinder.referenceSpans) {
                                parseErrors.push(
                                    new language.Issue(referenceSpan, "reference() cannot be invoked inside of a variable definition."));
                            }
                        }
                    }

                    resolve(parseErrors);
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    public get warnings(): language.Issue[] {
        // asdf do for all subscopes (user funcs, sub deployments)
        return this._warnings.getOrCacheValue(() => {
            const warnings: language.Issue[] = [];

            for (const parameterDefinition of this.parameterDefinitions) {
                const parameterReferences: Reference.List =
                    this.findReferences(Reference.ReferenceKind.Parameter, parameterDefinition.name.toString());
                if (parameterReferences.length === 1) {
                    warnings.push(
                        new language.Issue(parameterDefinition.name.span, `The parameter '${parameterDefinition.name.toString()}' is never used.`));
                }
            }

            for (const variableDefinition of this.variableDefinitions) {
                const variableReferences: Reference.List = this.findReferences(Reference.ReferenceKind.Variable, variableDefinition.name.toString());
                if (variableReferences.length === 1) {
                    warnings.push(
                        new language.Issue(variableDefinition.name.span, `The variable '${variableDefinition.name.toString()}' is never used.`));
                }
            }

            //asdf
            // for (const nsDefinition of this.namespaceDefinitions) {
            //     this._warnings.push(new language.Issue(nsDefinition.name.span, `namespace ${nsDefinition.name.toString()}`));

            //     for (const funcDefinition of nsDefinition.members) {
            //         this._warnings.push(new language.Issue(
            //             funcDefinition.name.span,
            //             `func ${funcDefinition.name.toString()}`)
            //         );
            //     }
            // }

            return warnings;
        });
    }

    public getFunctionCounts(): Histogram {
        const functionCounts = new Histogram();

        if (this.jsonParseResult.value) {
            // Our count should count every string in the template, even if it's repeated multiple times, so don't loop through
            //    _quotedStringToTleParseResultMap directly because that counts repeated strings only once.
            //
            GenericStringVisitor.visit(
                this.jsonParseResult.value,
                (stringValue: Json.StringValue): void => {
                    const tleParseResult = this.getTLEParseResultFromJSONStringValue(stringValue);
                    if (tleParseResult) {
                        let tleFunctionCountVisitor = FunctionCountVisitor.FunctionCountVisitor.visit(tleParseResult.expression);
                        functionCounts.add(tleFunctionCountVisitor.functionCounts);
                    }
                });
        }

        return functionCounts;
    }

    public get jsonParseResult(): Json.ParseResult {
        return this._jsonParseResult;
    }

    /**
     * Get the number of lines that are in the file.
     */
    public get lineCount(): number {
        return this._jsonParseResult.lineLengths.length;
    }

    /**
     * Get the maximum column index for the provided line. For the last line in the file,
     * the maximum column index is equal to the line length. For every other line in the file,
     * the maximum column index is less than the line length.
     */
    public getMaxColumnIndex(lineIndex: number): number {
        return this._jsonParseResult.getMaxColumnIndex(lineIndex);
    }

    /**
     * Get the maximum document character index for this deployment template.
     */
    public get maxCharacterIndex(): number {
        return this._jsonParseResult.maxCharacterIndex;
    }

    public get parameterDefinitions(): IParameterDefinition[] { //asdf remove
        return this._topLevelScope.parameterDefinitions;
    }

    public get variableDefinitions(): Json.Property[] { //asdf remove
        return this._topLevelScope.variableDefinitions;
    }

    public get namespaceDefinitions(): UserFunctionNamespaceDefinition[] { //asdf remove
        return this._topLevelScope.namespaceDefinitions;
    }

    private getTopLevelParameterDefinitions(): ParameterDefinition[] {
        const parameterDefinitions: ParameterDefinition[] = [];

        if (this._topLevelValue) {
            const parameters: Json.ObjectValue | null = Json.asObjectValue(this._topLevelValue.getPropertyValue("parameters")); //testpoint
            if (parameters) {
                for (const parameter of parameters.properties) {
                    parameterDefinitions.push(new ParameterDefinition(parameter)); //testpoint
                }
            }
        }

        return parameterDefinitions;
    }

    private getTopLevelVariableDefinitions(): Json.Property[] {
        if (this._topLevelValue) {
            // The "variables" section is only valid at the top level of the deployment
            const variables: Json.ObjectValue | null = Json.asObjectValue(this._topLevelValue.getPropertyValue("variables")); //testpoint
            if (variables) {
                return variables.properties; //testpoint
            }
        }

        return []; //testpoint
    }

    private getTopLevelNamespaceDefinitions(): UserFunctionNamespaceDefinition[] {
        const namespaceDefinitions: UserFunctionNamespaceDefinition[] = [];

        // Example:
        //
        // "functions": [
        //     { << This is a UserFunctionNamespaceDefinition
        //       "namespace": "<namespace-for-functions>",
        //       "members": { << This is a UserFunctionDefinition
        //         "<function-name>": {
        //           "parameters": [
        //             {
        //               "name": "<parameter-name>",
        //               "type": "<type-of-parameter-value>"
        //             }
        //           ],
        //           "output": {
        //             "type": "<type-of-output-value>",
        //             "value": "<function-return-value>"
        //           }
        //         }
        //       }
        //     }
        //   ],

        if (this._topLevelValue) {
            const functionNamespacesArray: Json.ArrayValue | null = Json.asArrayValue(this._topLevelValue.getPropertyValue("functions"));
            if (functionNamespacesArray) {
                for (let namespaceElement of functionNamespacesArray.elements) {
                    const namespaceObject = Json.asObjectValue(namespaceElement);
                    if (namespaceObject) {
                        let namespace = UserFunctionNamespaceDefinition.createIfValid(namespaceObject);
                        if (namespace) {
                            namespaceDefinitions.push(namespace);
                        }
                    }
                }
            }
        }

        return namespaceDefinitions;
    }

    public getDocumentCharacterIndex(documentLineIndex: number, documentColumnIndex: number): number {
        return this._jsonParseResult.getCharacterIndex(documentLineIndex, documentColumnIndex);
    }

    public getDocumentPosition(documentCharacterIndex: number): language.Position {
        return this._jsonParseResult.getPositionFromCharacterIndex(documentCharacterIndex);
    }

    public getJSONTokenAtDocumentCharacterIndex(documentCharacterIndex: number): Json.Token | null {
        return this._jsonParseResult.getTokenAtCharacterIndex(documentCharacterIndex);
    }

    public getJSONValueAtDocumentCharacterIndex(documentCharacterIndex: number): Json.Value | null {
        return this._jsonParseResult.getValueAtCharacterIndex(documentCharacterIndex);
    }

    public getContextFromDocumentLineAndColumnIndexes(documentLineIndex: number, documentColumnIndex: number): PositionContext {
        return PositionContext.fromDocumentLineAndColumnIndexes(this, this.topLevelScope/*asdf?*/, documentLineIndex, documentColumnIndex);
    }

    public getContextFromDocumentCharacterIndex(documentCharacterIndex: number): PositionContext {
        return PositionContext.fromDocumentCharacterIndex(this, this.topLevelScope/*asdf?*/, documentCharacterIndex);
    }

    public getTLEParseResultFromJSONToken(jsonToken: Json.Token | null): TLE.ParseResult | null {
        if (!jsonToken || jsonToken.type !== Json.TokenType.QuotedString) {
            // Don't do a map lookup if it's not a quoted string parse
            return null;
        }

        const unquoted = Utilities.unquote(jsonToken.toString());
        return this.getTLEParseResultFromString(unquoted);
    }

    // Note: I don't think this should ever return null, but being defensive for now
    public getTLEParseResultFromJSONStringValue(jsonStringValue: Json.StringValue): TLE.ParseResult | null {
        const result = this.getTLEParseResultFromString(jsonStringValue.toString());
        return result;
    }

    // asdf be lazy?
    // Note: I don't think this should ever return null (unless not a string), but being defensive for now
    private getTLEParseResultFromString(value: string): TLE.ParseResult | null {
        assert(typeof value === "string");
        const result: TLE.ParseResult | undefined = this.quotedStringToTleParseResultMap.get(value);
        assert(result); // asdf why would this be null?  - probably best to be safe and remove this assert
        return result ? result : null;
    }

    public findReferences(referenceType: Reference.ReferenceKind, referenceName: string): Reference.List { //asdf need scope
        const result: Reference.List = new Reference.List(referenceType);

        if (referenceName) {
            switch (referenceType) {
                case Reference.ReferenceKind.Parameter:
                    const parameterDefinition: IParameterDefinition | null = this.topLevelScope.getParameterDefinition(referenceName); //asdf
                    if (parameterDefinition) {
                        result.add(parameterDefinition.name.unquotedSpan);
                    }
                    break;

                case Reference.ReferenceKind.Variable:
                    const variableDefinition: Json.Property | null = this.topLevelScope.getVariableDefinition(referenceName); //asdf
                    if (variableDefinition) {
                        result.add(variableDefinition.name.unquotedSpan);
                    }
                    break;

                default:
                    assert.fail(`Unrecognized Reference.Kind: ${referenceType}`);
                    break;
            }

            for (const jsonStringToken of this.jsonQuotedStringTokens) {
                const tleParseResult: TLE.ParseResult | null = this.getTLEParseResultFromJSONToken(jsonStringToken);
                if (tleParseResult && tleParseResult.expression) {
                    const visitor = FindReferencesVisitor.FindReferencesVisitor.visit(tleParseResult.expression, referenceType, referenceName);
                    result.addAll(visitor.references.translate(jsonStringToken.span.startIndex));
                }
            }
        }

        return result;
    }
}
